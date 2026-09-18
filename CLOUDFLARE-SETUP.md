# Cloudflare Setup — 4NE-1 Lastenheft Dashboard

Diese Anleitung erklärt, wie das Backend des Requirements-Dashboards auf Cloudflare funktioniert: welche Bausteine es gibt, wie Lese-/Schreibvorgänge (Reads/Writes) entstehen, welche Limits gelten und worauf man beim Ändern des Codes achten muss.

## 1. Architektur-Überblick

```
Browser (Nutzer)
   │
   │  fetch() Requests (GET / PATCH)
   ▼
Cloudflare Worker  (worker.js)
   │
   ├──► D1 Datenbank ("store" Tabelle)   ← Dashboard-Daten + Backups + Rate-Limit-Zähler
   │
   └──► KV Namespace ("KV")              ← nur noch Fallback, falls D1 nicht gebunden ist
```

- **Frontend:** `index.html`, gehostet über **GitHub Pages** (`david-4ne1.github.io/4ne1-lastenheft-dashboard/`). Reines React ohne Build-Schritt, lädt React per CDN.
- **Backend:** ein einziger **Cloudflare Worker** (`4ne1-lastenheft-dashboard`), der als kleine REST-API dient (`/data`, `/backups`, `/backup/...`).
- **Datenspeicher:** **Cloudflare D1** (SQLite-artige Datenbank), Tabelle `store` mit den Spalten `key` (TEXT, Primary Key) und `value` (TEXT, meist JSON-String).
- **Konfiguration:** `wrangler.toml` im Repo — legt fest, welche Bindings (KV, D1) der Worker beim Deploy bekommt.
- **Deployment:** Cloudflare ist direkt mit dem GitHub-Repo verbunden ("Git-Integration"). Jeder Push/Merge auf den `main`-Branch löst automatisch ein neues Deployment des Workers aus, basierend auf `wrangler.toml`.

## 2. Wie entstehen Reads und Writes?

### 2.1 Beim Laden des Dashboards
- `GET /data` → 1 D1-Read. Liefert den kompletten aktuellen Datenstand (alle Requirement-Edits) als JSON zurück.

### 2.2 Beim Speichern einer Änderung
Wenn ein Nutzer ein Feld bearbeitet (z. B. einen Kommentar eintippt):
1. Die Änderung wird **sofort** im Browser (`localStorage`) gespeichert — das kostet keine Cloudflare-Operation.
2. Nach **3 Sekunden Debounce** (wartet, ob noch mehr geändert wird) wird ein `PATCH /data` Request an den Worker geschickt.
3. Der Worker liest den aktuellen Stand (1 D1-Read), merged das Delta hinein, schreibt das Ergebnis zurück (1 D1-Write).
4. Zusätzlich prüft der Worker stündlich, ob ein automatisches Backup fällig ist (`autoBackup()`), was ggf. 1-2 weitere D1-Writes verursacht (aber nur einmal pro Stunde, nicht pro Request).

### 2.3 Live-Sync zwischen mehreren Nutzern (Polling)
Damit alle Nutzer den gleichen Stand sehen, pollt jeder offene Browser-Tab periodisch:
- **Tagsüber (7–24 Uhr):** alle **120 Sekunden**
- **Nachts (0–7 Uhr):** alle **300 Sekunden**
- **Pausiert automatisch**, wenn der Browser-Tab im Hintergrund ist (nicht sichtbar) — kein Polling, keine Kosten.
- **Bei Fehlern (429, Netzwerkfehler):** exponentielles Backoff bis maximal 10 Minuten Intervall.
- **Beim Zurückkehren zum Tab:** sofortiger Sync statt Warten auf den nächsten Timer.

Jeder Poll-Zyklus ist ein `GET /data` (1 D1-Read). Falls dabei lokale Änderungen entdeckt werden, die der Server noch nicht kennt, wird zusätzlich ein `PATCH` (1 Read + 1 Write) ausgelöst.

### 2.4 Rate-Limiting (Schutz vor Missbrauch)
Jeder Request (egal ob GET oder PATCH) prüft zusätzlich einen **Rate-Limit-Zähler pro IP-Adresse** (max. 60 Requests pro 60 Sekunden). Dieser Zähler wird ebenfalls in D1 gespeichert (`rl:<ip>` Key) — das ist 1 zusätzlicher Read + 1 zusätzlicher Write **pro Request**.

> **Wichtig:** Ursprünglich lief dieser Zähler über **KV** statt D1. Das war das eigentliche Problem, das das KV-Tageslimit gesprengt hat — nicht die Dashboard-Daten selbst! Siehe Abschnitt 4.

## 3. Free-Tier-Limits im Vergleich

| | **Workers KV** (alt) | **D1** (aktuell) |
|---|---|---|
| Reads/Tag | 100.000 | 5.000.000 |
| Writes/Tag | **1.000** | **100.000** |
| Storage | 1 GB | 5 GB |

Das KV-Free-Tier-Limit gilt **pro Cloudflare-Account**, nicht pro Projekt — es zählt also gegen alle Worker/KV-Namespaces gleichzeitig (auch andere Projekte wie `4ne1planner`, `board-state` etc.). Mit 4 Personen, die gleichzeitig im Dashboard arbeiten (Polling + Speichern + Rate-Limiting), war das 1.000er-Write-Limit von KV binnen Stunden erreicht.

D1 hat mit 100.000 Writes/Tag genug Puffer für deutlich mehr gleichzeitige Nutzer und mehrere Projekte parallel.

## 4. Wichtige Stolperfalle: Bindings in `wrangler.toml`

Ein Cloudflare Worker "kennt" seine Datenbank-/KV-Verbindungen nur über sogenannte **Bindings**. Es gibt zwei Wege, ein Binding zu setzen:

1. **Manuell im Cloudflare Dashboard** (Worker → Settings → Bindings → "Add")
2. **Deklarativ in `wrangler.toml`** im Repo

**Das Problem:** Wenn ein Worker über die **Git-Integration** automatisch deployed wird (bei jedem Push auf `main`), nutzt Cloudflare **ausschließlich `wrangler.toml`** als Quelle der Wahrheit für Bindings. Ein Binding, das nur manuell im Dashboard gesetzt wurde, wird beim nächsten Auto-Deploy **stillschweigend wieder entfernt**.

Das ist uns genau so passiert: Wir haben D1 zuerst nur im Dashboard gebunden, ein Merge auf `main` hat den Worker neu deployed — und dabei das D1-Binding wieder gelöscht. Der Worker fiel zurück auf KV (das schon leer/voll war) und stürzte ab.

**Lösung:** Jedes Binding, das dauerhaft bestehen soll, muss in `wrangler.toml` stehen:

```toml
name = "4ne1-lastenheft-dashboard"
main = "worker.js"
compatibility_date = "2024-12-01"

[[kv_namespaces]]
binding = "KV"
id = "940e73e95bdc4fd78eeda99489a728fb"

[[d1_databases]]
binding = "DB"
database_name = "lastenheft-dashboard"
database_id = "5beee687-4d6f-4607-ada3-4d9cc306f4f4"
```

**Merke:** Bindings über die Dashboard-UI hinzufügen ist gut zum schnellen Testen — aber sobald der Worker git-verbunden ist, muss jedes Binding zusätzlich in `wrangler.toml` landen, sonst geht es beim nächsten Deploy wieder verloren.

## 5. Fehlerdiagnose

### "error code: 1101" beim Aufruf der Worker-URL
Bedeutet: Der Worker-Code wirft eine unbehandelte JavaScript-Exception. Ursache herausfinden über:

1. Cloudflare Dashboard → Worker → Tab **"Observability"**
2. Live-Log-Stream starten (oder Zeitfenster oben rechts erneut anklicken zum Aktualisieren)
3. Auf den neuesten roten "error"-Eintrag klicken → zeigt Stacktrace + Fehlermeldung

Typische Ursachen, die wir hatten:
- `KV put() limit exceeded for the day.` → Tageslimit für KV-Writes erschöpft
- Ein D1-Binding, das durch einen Auto-Deploy wieder verschwunden ist (siehe Abschnitt 4)

### Aktive Version prüfen
Cloudflare Dashboard → Worker → Tab **"Deployments"** → "Version History" zeigt, welche Version aktuell live ist und von wo sie kam (manuell / Git-Merge).

## 6. Nützliche Endpoints

| Endpoint | Methode | Zweck |
|---|---|---|
| `/data` | GET | Kompletten Datenstand abrufen |
| `/data` | PATCH | Delta (nur geänderte Felder) mergen |
| `/data` | POST | Kompletten Datenstand überschreiben |
| `/data` | DELETE | Datenstand zurücksetzen (leert auf `{}`) |
| `/backups` | GET | Liste aller automatischen Backups |
| `/backup/<key>` | GET | Ein bestimmtes Backup abrufen |
| `/backup/<key>` | POST | Ein Backup wiederherstellen |
| `/migrate-kv-to-d1` | GET | Einmalige Migration alter KV-Daten nach D1 |

Alle Requests brauchen den Header `X-API-Key: <API_KEY>`.

## 7. Zusammenfassung der Optimierungen (chronologisch)

1. **Bidirektionaler Sync-Fix** — Delta-Merge statt "wer zuerst speichert gewinnt"
2. **Polling-Intervall** — 30s → 120s (Tag) / 300s (Nacht)
3. **Smart Sync** — Polling pausiert bei Hintergrund-Tab, Backoff bei Fehlern
4. **Write-Debounce** — 1s → 3s, bündelt mehr Änderungen in einen Request
5. **429-Backoff bei Writes** — kein sinnloses Wiederholen bei erschöpftem Kontingent
6. **KV → D1 Migration** — Dashboard-Daten und Backups laufen jetzt über D1 (100× mehr Writes/Tag)
7. **Rate-Limiter → D1** — auch der letzte verbliebene KV-Verbraucher wurde umgezogen
