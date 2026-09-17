const RATE_LIMIT = 60;
const RATE_WINDOW = 60;

export default {
  async fetch(request, env) {
    const corsHeaders = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, PATCH, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, X-API-Key',
    };

    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders });
    }

    const apiKey = env.API_KEY || '';
    if (apiKey) {
      const provided = request.headers.get('X-API-Key') || '';
      if (provided !== apiKey) {
        return new Response(JSON.stringify({ error: 'unauthorized' }), {
          status: 401,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }
    }

    try {
      const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
      const rlKey = 'rl:' + ip;
      const rlData = await env.KV.get(rlKey, 'json');
      const now = Math.floor(Date.now() / 1000);
      let count = 0;
      let windowStart = now;
      if (rlData && (now - rlData.start) < RATE_WINDOW) {
        count = rlData.count;
        windowStart = rlData.start;
      }
      if (count >= RATE_LIMIT) {
        return new Response(JSON.stringify({ error: 'rate limit exceeded' }), {
          status: 429,
          headers: { ...corsHeaders, 'Content-Type': 'application/json', 'Retry-After': String(RATE_WINDOW - (now - windowStart)) },
        });
      }
      await env.KV.put(rlKey, JSON.stringify({ start: windowStart, count: count + 1 }), { expirationTtl: RATE_WINDOW * 2 });
    } catch (e) {
      // KV unavailable (e.g. daily quota exceeded) — fail open, do not block requests
    }

    const url = new URL(request.url);
    const KEY = 'dashboard-data';

    const useD1 = !!env.DB;

    async function dbGet(key) {
      if (useD1) {
        const row = await env.DB.prepare('SELECT value FROM store WHERE key = ?').bind(key).first();
        return row ? JSON.parse(row.value) : null;
      }
      return env.KV.get(key, 'json');
    }

    async function dbGetText(key) {
      if (useD1) {
        const row = await env.DB.prepare('SELECT value FROM store WHERE key = ?').bind(key).first();
        return row ? row.value : null;
      }
      return env.KV.get(key, 'text');
    }

    async function dbPut(key, value, opts) {
      if (useD1) {
        await env.DB.prepare('INSERT OR REPLACE INTO store (key, value) VALUES (?, ?)').bind(key, typeof value === 'string' ? value : JSON.stringify(value)).run();
        return;
      }
      await env.KV.put(key, typeof value === 'string' ? value : JSON.stringify(value), opts || {});
    }

    async function dbList(prefix) {
      if (useD1) {
        const rows = await env.DB.prepare("SELECT key FROM store WHERE key LIKE ? AND key != 'backup-latest-ts' ORDER BY key DESC LIMIT 100").bind(prefix + '%').all();
        return rows.results.map(function(r) { return { name: r.key }; });
      }
      const list = await env.KV.list({ prefix: prefix, limit: 100 });
      return list.keys.filter(function(k) { return k.name !== 'backup-latest-ts'; });
    }

    const BACKUP_INTERVAL = 3600;

    async function autoBackup() {
      const lastTs = await dbGetText('backup-latest-ts');
      const now = Date.now();
      if (lastTs && (now - parseInt(lastTs)) < BACKUP_INTERVAL * 1000) return;
      const current = await dbGetText(KEY);
      if (current && current !== '{}') {
        const ts = new Date().toISOString().replace(/[:.]/g, '-');
        await dbPut('backup-' + ts, current, { expirationTtl: 2592000 });
        await dbPut('backup-latest-ts', String(now));
      }
    }

    if (url.pathname === '/data') {
      if (request.method === 'GET') {
        const data = await dbGet(KEY) || {};
        return new Response(JSON.stringify(data), {
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }

      if (request.method === 'PATCH') {
        await autoBackup();
        const delta = await request.json();
        const existing = await dbGet(KEY) || {};
        Object.keys(delta).forEach(function (id) {
          if (!existing[id]) existing[id] = {};
          Object.keys(delta[id]).forEach(function (field) {
            existing[id][field] = delta[id][field];
          });
        });
        await dbPut(KEY, JSON.stringify(existing));
        return new Response(JSON.stringify({ ok: true }), {
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }

      if (request.method === 'POST') {
        await autoBackup();
        const body = await request.json();
        await dbPut(KEY, JSON.stringify(body));
        return new Response(JSON.stringify({ ok: true }), {
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }

      if (request.method === 'DELETE') {
        await autoBackup();
        await dbPut(KEY, '{}');
        return new Response(JSON.stringify({ ok: true }), {
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }
    }

    if (url.pathname === '/backups') {
      const keys = await dbList('backup-');
      const backups = keys.map(function(k) { return { key: k.name }; });
      backups.sort(function(a, b) { return b.key.localeCompare(a.key); });
      return new Response(JSON.stringify(backups), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    if (url.pathname.startsWith('/backup/')) {
      const backupKey = decodeURIComponent(url.pathname.slice(8));
      if (request.method === 'GET') {
        const data = await dbGet(backupKey);
        if (!data) return new Response(JSON.stringify({ error: 'not found' }), { status: 404, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
        return new Response(JSON.stringify(data), {
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }
      if (request.method === 'POST') {
        const current = await dbGetText(KEY);
        if (current && current !== '{}') {
          const ts = new Date().toISOString().replace(/[:.]/g, '-');
          await dbPut('backup-' + ts, current, { expirationTtl: 2592000 });
        }
        const data = await dbGetText(backupKey);
        if (!data) return new Response(JSON.stringify({ error: 'not found' }), { status: 404, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
        await dbPut(KEY, data);
        return new Response(JSON.stringify({ ok: true, restored: backupKey }), {
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }
    }

    if (url.pathname === '/migrate-kv-to-d1') {
      if (!useD1) {
        return new Response(JSON.stringify({ error: 'D1 not bound' }), { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
      }
      const data = await env.KV.get(KEY, 'text');
      if (data) {
        await env.DB.prepare('INSERT OR REPLACE INTO store (key, value) VALUES (?, ?)').bind(KEY, data).run();
        return new Response(JSON.stringify({ ok: true, migrated: KEY, size: data.length }), {
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }
      return new Response(JSON.stringify({ ok: true, migrated: null }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    return new Response(JSON.stringify({ error: 'not found' }), { status: 404, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
  },
};
