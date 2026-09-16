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

    const url = new URL(request.url);
    const KEY = 'dashboard-data';
    const BACKUP_INTERVAL = 3600;

    async function autoBackup() {
      const lastKey = await env.KV.get('backup-latest-ts');
      const now = Date.now();
      if (lastKey && (now - parseInt(lastKey)) < BACKUP_INTERVAL * 1000) return;
      const current = await env.KV.get(KEY, 'text');
      if (current && current !== '{}') {
        const ts = new Date().toISOString().replace(/[:.]/g, '-');
        await env.KV.put('backup-' + ts, current, { expirationTtl: 2592000 });
        await env.KV.put('backup-latest-ts', String(now));
      }
    }

    if (url.pathname === '/data') {
      if (request.method === 'GET') {
        const data = await env.KV.get(KEY, 'json') || {};
        return new Response(JSON.stringify(data), {
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }

      if (request.method === 'PATCH') {
        await autoBackup();
        const delta = await request.json();
        const existing = await env.KV.get(KEY, 'json') || {};
        Object.keys(delta).forEach(function (id) {
          if (!existing[id]) existing[id] = {};
          Object.keys(delta[id]).forEach(function (field) {
            existing[id][field] = delta[id][field];
          });
        });
        await env.KV.put(KEY, JSON.stringify(existing));
        return new Response(JSON.stringify({ ok: true }), {
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }

      if (request.method === 'POST') {
        await autoBackup();
        const body = await request.json();
        await env.KV.put(KEY, JSON.stringify(body));
        return new Response(JSON.stringify({ ok: true }), {
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }

      if (request.method === 'DELETE') {
        await autoBackup();
        await env.KV.put(KEY, '{}');
        return new Response(JSON.stringify({ ok: true }), {
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }
    }

    if (url.pathname === '/backups') {
      const list = await env.KV.list({ prefix: 'backup-', limit: 100 });
      const backups = list.keys
        .filter(function(k) { return k.name !== 'backup-latest-ts'; })
        .map(function(k) { return { key: k.name }; });
      backups.sort(function(a, b) { return b.key.localeCompare(a.key); });
      return new Response(JSON.stringify(backups), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    if (url.pathname.startsWith('/backup/')) {
      const backupKey = decodeURIComponent(url.pathname.slice(8));
      if (request.method === 'GET') {
        const data = await env.KV.get(backupKey, 'json');
        if (!data) return new Response(JSON.stringify({ error: 'not found' }), { status: 404, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
        return new Response(JSON.stringify(data), {
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }
      if (request.method === 'POST') {
        const current = await env.KV.get(KEY, 'text');
        if (current && current !== '{}') {
          const ts = new Date().toISOString().replace(/[:.]/g, '-');
          await env.KV.put('backup-' + ts, current, { expirationTtl: 2592000 });
        }
        const data = await env.KV.get(backupKey, 'text');
        if (!data) return new Response(JSON.stringify({ error: 'not found' }), { status: 404, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
        await env.KV.put(KEY, data);
        return new Response(JSON.stringify({ ok: true, restored: backupKey }), {
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }
    }

    return new Response(JSON.stringify({ error: 'not found' }), { status: 404, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
  },
};
