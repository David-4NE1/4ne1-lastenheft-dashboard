export default {
  async fetch(request, env) {
    const corsHeaders = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, PATCH, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    };

    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders });
    }

    const url = new URL(request.url);
    const KEY = 'dashboard-data';

    async function autoBackup() {
      const current = await env.KV.get(KEY, 'text');
      if (current && current !== '{}') {
        const ts = new Date().toISOString().replace(/[:.]/g, '-');
        await env.KV.put('backup-' + ts, current, { expirationTtl: 604800 });
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
      if (request.method === 'GET') {
        const list = await env.KV.list({ prefix: 'backup-', limit: 50 });
        const backups = list.keys.map(k => ({ key: k.name, ts: k.name.replace('backup-', '').replace(/-/g, function(m, i) { return i === 4 || i === 7 ? '-' : i === 13 || i === 16 ? ':' : i === 19 ? '.' : m; }) }));
        backups.sort(function(a, b) { return b.key.localeCompare(a.key); });
        return new Response(JSON.stringify(backups), {
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }
    }

    if (url.pathname.startsWith('/backup/')) {
      const backupKey = url.pathname.replace('/backup/', '');
      if (request.method === 'GET') {
        const data = await env.KV.get(backupKey, 'json');
        if (!data) return new Response('Not found', { status: 404, headers: corsHeaders });
        return new Response(JSON.stringify(data), {
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }
      if (request.method === 'POST') {
        await autoBackup();
        const data = await env.KV.get(backupKey, 'text');
        if (!data) return new Response('Not found', { status: 404, headers: corsHeaders });
        await env.KV.put(KEY, data);
        return new Response(JSON.stringify({ ok: true, restored: backupKey }), {
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }
    }

    return new Response('Not found', { status: 404, headers: corsHeaders });
  },
};
