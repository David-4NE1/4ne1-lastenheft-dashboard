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

    const url = new URL(request.url);
    const LOAD_URL = env.PA_LOAD_URL || '';
    const SAVE_URL = env.PA_SAVE_URL || '';

    async function loadFromSP() {
      if (!LOAD_URL) throw new Error('PA_LOAD_URL not configured');
      const resp = await fetch(LOAD_URL, { method: 'GET' });
      if (!resp.ok) throw new Error('SP load failed: ' + resp.status);
      const text = await resp.text();
      try { return JSON.parse(text); } catch (e) { return {}; }
    }

    async function saveToSP(data) {
      if (!SAVE_URL) throw new Error('PA_SAVE_URL not configured');
      const resp = await fetch(SAVE_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data),
      });
      if (!resp.ok) throw new Error('SP save failed: ' + resp.status);
    }

    if (url.pathname === '/data') {
      try {
        if (request.method === 'GET') {
          const data = await loadFromSP();
          return new Response(JSON.stringify(data), {
            headers: { ...corsHeaders, 'Content-Type': 'application/json' },
          });
        }

        if (request.method === 'PATCH') {
          const delta = await request.json();
          const existing = await loadFromSP();
          Object.keys(delta).forEach(function (id) {
            if (!existing[id]) existing[id] = {};
            Object.keys(delta[id]).forEach(function (field) {
              existing[id][field] = delta[id][field];
            });
          });
          await saveToSP(existing);
          return new Response(JSON.stringify({ ok: true }), {
            headers: { ...corsHeaders, 'Content-Type': 'application/json' },
          });
        }

        if (request.method === 'POST') {
          const body = await request.json();
          await saveToSP(body);
          return new Response(JSON.stringify({ ok: true }), {
            headers: { ...corsHeaders, 'Content-Type': 'application/json' },
          });
        }

        if (request.method === 'DELETE') {
          await saveToSP({});
          return new Response(JSON.stringify({ ok: true }), {
            headers: { ...corsHeaders, 'Content-Type': 'application/json' },
          });
        }
      } catch (e) {
        return new Response(JSON.stringify({ error: 'sharepoint error', detail: e.message }), {
          status: 502,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }
    }

    return new Response(JSON.stringify({ error: 'not found' }), { status: 404, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
  },
};
