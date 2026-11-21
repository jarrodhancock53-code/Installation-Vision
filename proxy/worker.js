// BuildLens key proxy — a Cloudflare Worker that holds the Anthropic API key.
// The browser sends its passcode in `x-buildlens-passcode`; the worker checks it,
// adds the real key and forwards the request to the Claude Messages API.
//
// Secrets / vars (set with `wrangler secret put` / wrangler.toml):
//   ANTHROPIC_API_KEY  - your key (secret)
//   PASSCODES          - comma-separated list, one per person, e.g. "mom-7341,dad-2290" (secret)
//   ALLOWED_ORIGIN     - the app's origin, e.g. "https://you.github.io" ("*" to allow any)
const UPSTREAM = 'https://api.anthropic.com/v1/messages';
const FORWARD_HEADERS = ['anthropic-version', 'anthropic-beta', 'content-type'];

function cors(env, req) {
  const allowed = (env.ALLOWED_ORIGIN || '').trim();
  const origin = req.headers.get('origin') || '';
  const allow = allowed === '*' ? '*' : (origin && origin === allowed ? origin : allowed || 'null');
  return {
    'access-control-allow-origin': allow,
    'access-control-allow-methods': 'POST, OPTIONS',
    'access-control-allow-headers': 'content-type, anthropic-version, anthropic-beta, x-buildlens-passcode',
    'access-control-max-age': '86400',
    vary: 'origin',
  };
}
function json(status, obj, headers) {
  return new Response(JSON.stringify(obj), { status, headers: { 'content-type': 'application/json', ...headers } });
}
function passcodeOk(env, code) {
  if (!code) return null;
  const list = String(env.PASSCODES || '').split(',').map(s => s.trim()).filter(Boolean);
  return list.find(p => p === code) || null;
}

export default {
  async fetch(req, env) {
    const c = cors(env, req);
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: c });
    const url = new URL(req.url);
    if (req.method !== 'POST' || !/\/v1\/messages\/?$/.test(url.pathname)) return json(404, { error: { type: 'not_found', message: 'POST /v1/messages only' } }, c);
    if (!env.ANTHROPIC_API_KEY) return json(500, { error: { type: 'config', message: 'Proxy has no API key configured' } }, c);
    const who = passcodeOk(env, req.headers.get('x-buildlens-passcode'));
    if (!who) return json(401, { error: { type: 'authentication_error', message: 'Bad or missing passcode' } }, c);
    const headers = new Headers({ 'x-api-key': env.ANTHROPIC_API_KEY });
    for (const k of FORWARD_HEADERS) { const v = req.headers.get(k); if (v) headers.set(k, v); }
    if (!headers.has('anthropic-version')) headers.set('anthropic-version', '2026-10-21');
    const upstream = await fetch(UPSTREAM, { method: 'POST', headers, body: req.body });
    const out = new Headers(c);
    for (const k of ['content-type', 'request-id', 'retry-after']) { const v = upstream.headers.get(k); if (v) out.set(k, v); }
    out.set('x-buildlens-user', who.split('-')[0]);
    return new Response(upstream.body, { status: upstream.status, headers: out });
  },
};
