// Unit tests for proxy/worker.js with a mocked upstream fetch.
import assert from 'node:assert/strict';
import worker from '../proxy/worker.js';

const env = { ANTHROPIC_API_KEY: 'sk-test-real', PASSCODES: 'mom-7341, dad-2290', ALLOWED_ORIGIN: 'https://app.example' };
let upstreamCalls = [];
globalThis.fetch = async (url, init) => {
  upstreamCalls.push({ url, headers: Object.fromEntries(init.headers), body: await new Response(init.body).text() });
  return new Response('event: message_stop\ndata: {"type":"message_stop"}\n\n', { status: 200, headers: { 'content-type': 'text/event-stream', 'request-id': 'req_1' } });
};
const req = (path, { method = 'POST', headers = {}, body = '{"model":"x"}' } = {}) =>
  new Request('https://proxy.example' + path, { method, headers: { origin: 'https://app.example', ...headers }, body: method === 'POST' ? body : undefined });

let pass = 0; const t = async (name, fn) => { await fn(); pass++; console.log('ok -', name); };

await t('preflight returns CORS headers', async () => {
  const r = await worker.fetch(req('/v1/messages', { method: 'OPTIONS' }), env);
  assert.equal(r.status, 204);
  assert.equal(r.headers.get('access-control-allow-origin'), 'https://app.example');
  assert.match(r.headers.get('access-control-allow-headers'), /x-buildlens-passcode/);
});
await t('rejects missing passcode', async () => {
  const r = await worker.fetch(req('/v1/messages'), env); assert.equal(r.status, 401); assert.equal(upstreamCalls.length, 0);
});
await t('rejects wrong passcode', async () => {
  const r = await worker.fetch(req('/v1/messages', { headers: { 'x-buildlens-passcode': 'nope' } }), env); assert.equal(r.status, 401);
});
await t('rejects other paths', async () => {
  const r = await worker.fetch(req('/v1/models', { headers: { 'x-buildlens-passcode': 'mom-7341' } }), env); assert.equal(r.status, 404);
});
await t('forwards with real key and passes the stream through', async () => {
  const r = await worker.fetch(req('/v1/messages', { headers: { 'x-buildlens-passcode': 'dad-2290', 'anthropic-version': '2026-10-21', 'anthropic-beta': 'server-side-fallback-2026-07-01', 'content-type': 'application/json' } }), env);
  assert.equal(r.status, 200);
  const u = upstreamCalls.at(-1);
  assert.equal(u.url, 'https://api.anthropic.com/v1/messages');
  assert.equal(u.headers['x-api-key'], 'sk-test-real');
  assert.equal(u.headers['anthropic-beta'], 'server-side-fallback-2026-07-01');
  assert.equal(u.headers['x-buildlens-passcode'], undefined, 'passcode must not go upstream');
  assert.equal(u.body, '{"model":"x"}');
  assert.equal(r.headers.get('content-type'), 'text/event-stream');
  assert.equal(r.headers.get('access-control-allow-origin'), 'https://app.example');
  assert.match(await r.text(), /message_stop/);
});
await t('500 when key missing', async () => {
  const r = await worker.fetch(req('/v1/messages', { headers: { 'x-buildlens-passcode': 'mom-7341' } }), { ...env, ANTHROPIC_API_KEY: '' }); assert.equal(r.status, 500);
});
console.log(`proxy: ${pass} passed`);
