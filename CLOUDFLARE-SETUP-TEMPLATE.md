# Cloudflare Setup — Vorlage für HTML-Dashboards mit Live-Sync

Generische Anleitung für ein Setup: **statisches HTML-Dashboard (z. B. GitHub Pages) + Cloudflare Worker als kleine API + KV oder D1 als Datenspeicher**. Projekt-spezifische Stellen sind mit `<<...>>` markiert — dort deine eigenen Werte eintragen.

## 1. Architektur-Überblick

```
Browser (Nutzer)
   │
   │  fetch() Requests (GET / PATCH / POST)
   ▼
Cloudflare Worker  (<<worker.js>>)
   │
   ├──► D1 Datenbank (Tabelle "store": key TEXT PK, value TEXT)   ← empfohlen für Daten + Backups + Rate-Limiting
   │
   └──► KV Namespace                                              ← optional als Fallback, oder für sehr kleine Datenmengen
```

- **Frontend:** `<<index.html>>`, gehostet über **GitHub Pages** oder einen beliebigen statischen Host.
- **Backend:** ein **Cloudflare Worker**, der als REST-API dient. Typische Routen: `<<GET /data>>`, `<<PATCH /data>>`, ggf. `/backups`.
- **Datenspeicher:** **Cloudflare D1** empfohlen (siehe Abschnitt 3, warum nicht KV).
- **Konfiguration:** `wrangler.toml` im Repo — legt fest, welche Bindings (KV, D1, Secrets) der Worker beim Deploy bekommt.
- **Deployment:** entweder manuell (`wrangler deploy`) oder über Cloudflares **Git-Integration** (automatisches Deploy bei Push auf einen bestimmten Branch, meist `main`).

## 2. Wie entstehen Reads und Writes? (Kostentreiber)

Bei jedem Dashboard mit Mehrbenutzer-Live-Sync entstehen Operationen aus typischerweise 4 Quellen — beim eigenen Projekt jede davon durchgehen und Zahlen eintragen:

| Quelle | Beispiel-Auslöser | Reads | Writes |
|---|---|---|---|
| Initiales Laden | Seite öffnen → `GET /data` | 1 | 0 |
| Speichern einer Änderung | Nutzer tippt etwas, nach Debounce → `PATCH /data` | 1 (merge) | 1 |
| Polling / Live-Sync | Alle `<<X Sekunden>>` im Hintergrund pollen alle offenen Tabs | 1 pro Tab pro Zyklus | 0 (nur bei Delta) |
| Rate-Limiting | Zähler pro IP bei **jedem** Request | 1 pro Request | 1 pro Request |

**Wichtigste Hebel zum Reduzieren, in Prioritätsreihenfolge:**

1. **Rate-Limit-Zähler nicht bei jedem Request extra persistieren**, falls vermeidbar — das ist oft der versteckte Hauptverbraucher, weil es sich mit JEDEM Request multipliziert (auch reinen Reads).
2. **Debounce beim Speichern** (z. B. 2–3 Sekunden warten, ob noch mehr Änderungen kommen, dann erst 1 Request senden statt 1 pro Tastenanschlag).
3. **Polling-Intervall an Nutzungszeiten anpassen** (z. B. länger nachts) und **pausieren wenn Tab im Hintergrund** ist (`document.hidden` prüfen).
4. **Exponentielles Backoff bei Fehlern** (429, Netzwerkfehler) statt sturem Retry im festen Intervall — verhindert, dass ein Ausfall das Kontingent weiter auffrisst.
5. **Lokale Zwischenspeicherung (`localStorage`)** als Sicherheitsnetz — Änderungen gehen nie verloren, auch wenn der Server gerade nicht erreichbar ist; sie werden beim nächsten erfolgreichen Sync nachgeholt.

## 3. Free-Tier-Limits im Vergleich: KV vs. D1

| | **Workers KV** | **D1** |
|---|---|---|
| Reads/Tag | 100.000 | 5.000.000 |
| Writes/Tag | **1.000** | **100.000** |
| Storage | 1 GB | 5 GB |
| Abfragen | nur Key-Value (get/put/list) | echtes SQL (SELECT, WHERE, JOIN, ...) |

**Empfehlung:** Für alles, was mehr als ein einzelner Gelegenheitsnutzer schreibt, **D1 statt KV** verwenden. Das KV-Write-Limit von 1.000/Tag ist **account-weit** (gilt für alle Worker/Projekte im selben Account zusammen) und wird bei mehreren aktiven Nutzern mit Polling + Speichern + Rate-Limiting überraschend schnell erreicht.

Falls schon ein Projekt auf KV läuft und umgezogen werden soll: eine simple Abstraktionsschicht (`dbGet`/`dbPut`/`dbList`) im Worker-Code einbauen, die zwischen KV und D1 umschalten kann — erleichtert die Migration und lässt Fallback-Optionen offen.

## 4. Wichtige Stolperfalle: Bindings in `wrangler.toml`

Ein Cloudflare Worker "kennt" seine Datenbank-/KV-Verbindungen nur über **Bindings**. Zwei Wege, ein Binding zu setzen:

1. **Manuell im Cloudflare Dashboard** (Worker → Settings → Bindings → "Add")
2. **Deklarativ in `wrangler.toml`** im Repo

**Das Problem:** Sobald ein Worker über die **Git-Integration** automatisch deployed wird, nutzt Cloudflare **ausschließlich `wrangler.toml`** als Quelle der Wahrheit für Bindings. Ein Binding, das nur manuell im Dashboard gesetzt wurde, wird beim nächsten Auto-Deploy **stillschweigend wieder entfernt** — ohne Fehlermeldung beim Deploy selbst, der Fehler zeigt sich erst zur Laufzeit (z. B. `env.DB` ist `undefined`, Code fällt auf einen Fallback zurück oder crasht).

**Lösung:** Jedes Binding, das dauerhaft bestehen soll, in `wrangler.toml` eintragen:

```toml
name = "<<worker-name>>"
main = "worker.js"
compatibility_date = "2024-12-01"

[[kv_namespaces]]
binding = "<<KV_BINDING_NAME>>"
id = "<<kv-namespace-id>>"

[[d1_databases]]
binding = "<<DB_BINDING_NAME>>"
database_name = "<<d1-database-name>>"
database_id = "<<d1-database-id>>"
```

Die IDs findet man im Cloudflare Dashboard: KV-Namespace-ID auf der KV-Übersichtsseite, D1-Database-ID auf der D1-Datenbank-Detailseite ("Settings" oder direkt auf der Übersicht).

**Merke:** Bindings über die Dashboard-UI hinzuzufügen ist praktisch zum schnellen Testen — aber sobald der Worker git-verbunden ist, muss jedes Binding zusätzlich in `wrangler.toml` landen, sonst geht es beim nächsten Deploy wieder verloren.

## 5. Fehlerdiagnose

### "error code: 1101" beim Aufruf der Worker-URL
Bedeutet: Der Worker-Code wirft eine unbehandelte JavaScript-Exception. Ursache herausfinden über:

1. Cloudflare Dashboard → Worker → Tab **"Observability"**
2. Live-Log-Stream starten (Button, meist "Begin log stream" o. ä.) oder Zeitfenster oben rechts neu anklicken zum Aktualisieren
3. Auf den neuesten roten "error"-Eintrag klicken → zeigt Stacktrace + Fehlermeldung, inkl. Datei/Zeile

Typische Ursachen:
- `KV put() limit exceeded for the day.` → Tageslimit für KV-Writes erschöpft (siehe Abschnitt 3, D1 nutzen)
- Ein Binding, das durch einen Auto-Deploy verschwunden ist (siehe Abschnitt 4)
- Fehlender oder falscher API-Key/Header im Request

### Aktive Version prüfen
Cloudflare Dashboard → Worker → Tab **"Deployments"** → "Version History" zeigt, welche Version aktuell live ist, wann sie deployed wurde und ob es ein manueller Edit oder ein Git-Merge war.

### Health-Check ohne Browser-Devtools
Falls F12/Devtools nicht verfügbar sind (z. B. auf Firmen-Rechnern gesperrt): Requests direkt per `curl` aus dem Terminal testen.

```bash
curl -X GET "https://<<worker-url>>/data" -H "X-API-Key: <<api-key>>"
```

Unter Windows/PowerShell: `curl.exe` explizit verwenden (nicht den PowerShell-Alias `curl`) und für JSON-Bodies **einfache Anführungszeichen** um den Body verwenden, damit die doppelten Anführungszeichen im JSON nicht von PowerShell "verschluckt" werden:

```powershell
curl.exe -X PATCH "https://<<worker-url>>/data" -H "X-API-Key: <<api-key>>" -H "Content-Type: application/json" -d '{"foo":"bar"}'
```

## 6. Muster für einen resilienten Sync-Mechanismus (Frontend)

Grober Ablauf, unabhängig vom konkreten Dashboard-Inhalt:

1. **Lokale Edits sofort in `localStorage`** speichern (nie verlieren, egal was der Server sagt).
2. **Debounce (2–3s)** vor dem Senden an den Server, um mehrere schnelle Änderungen zu bündeln.
3. **Bidirektionaler Merge beim Polling:** Server-Daten mit lokalen Daten Feld-für-Feld abgleichen — nicht einfach "wer zuletzt speichert, gewinnt" auf Datensatz-Ebene, sondern pro Feld vergleichen, sonst überschreiben sich gleichzeitig arbeitende Nutzer gegenseitig.
4. **`document.hidden`** prüfen, um Polling im Hintergrund-Tab zu pausieren.
5. **429/Fehler-Backoff:** bei Fehlern das Intervall exponentiell erhöhen (z. B. verdoppeln, gedeckelt bei 5–10 Minuten), bei Erfolg wieder reduzieren.
6. **`beforeunload`-Warnung**, falls noch ungespeicherte Änderungen ausstehen, damit Nutzer nicht versehentlich Änderungen verlieren beim Schließen des Tabs.

## 7. Checkliste für ein neues Projekt

- [ ] D1-Datenbank angelegt, Tabelle erstellt (`CREATE TABLE store (key TEXT PRIMARY KEY, value TEXT)`)
- [ ] D1-Binding **in `wrangler.toml`** eingetragen (nicht nur im Dashboard!)
- [ ] API-Key als Secret gesetzt (`wrangler secret put API_KEY` oder im Dashboard unter Settings → Variables)
- [ ] Rate-Limiting-Zähler läuft über D1, nicht über KV
- [ ] Frontend: Debounce + localStorage-Fallback + Polling mit Pause bei Hintergrund-Tab implementiert
- [ ] Nach jedem Worker-Code-Update: kurz `GET /data` testen, ob der Worker noch antwortet (kein 1101)
- [ ] Automatisches Backup (z. B. stündlich vor jedem Write die vorherige Version sichern)
