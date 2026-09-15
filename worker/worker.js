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

    if (url.pathname === '/data') {
      const KEY = 'dashboard-data';

      if (request.method === 'GET') {
        const data = await env.KV.get(KEY, 'json') || {};
        return new Response(JSON.stringify(data), {
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }

      if (request.method === 'PATCH') {
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
        const body = await request.json();
        await env.KV.put(KEY, JSON.stringify(body));
        return new Response(JSON.stringify({ ok: true }), {
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }

      if (request.method === 'DELETE') {
        await env.KV.put(KEY, '{}');
        return new Response(JSON.stringify({ ok: true }), {
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }
    }

    return new Response('Not found', { status: 404, headers: corsHeaders });
  },
};
