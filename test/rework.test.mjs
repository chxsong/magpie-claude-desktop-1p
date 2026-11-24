import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PassThrough, Readable, Writable } from 'node:stream';
import { injectModels } from '../src/models.mjs';
import { isDesktop, resolveModel } from '../src/routing.mjs';
import { FirstPartyProxy } from '../src/proxy.mjs';
import { clearTrust } from '../src/trust.mjs';
import { ensureCA } from '../src/certificates.mjs';
import { X509Certificate } from 'node:crypto';
import { agent } from '../agent.js';
const state = { models: [{ id: 'test/coder' }, { id: 'test/other' }] };
const body = { model: 'magpie/test/coder', messages: [{ role: 'user', content: 'test' }], tools: [{ name: 'Read' }] };
const headers = { 'user-agent': 'claude-cli/2.1.325 (external, claude-desktop, agent-sdk/0.3.325)', 'x-claude-code-request-class': 'main', 'x-claude-code-session-id': 'one' };
function directory(t) { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'magpie-rework-')); t.after(() => fs.rmSync(d, { recursive: true, force: true })); return d; }

test('Menu selection routes only Magpie IDs available in the catalog', () => {
  assert.equal(resolveModel('magpie/test/coder@high', state.models).target, 'test/coder');
  assert.equal(resolveModel('magpie/missing', state.models).status, 404);
  assert.deepEqual(resolveModel('claude-test', state.models), { reason: 'native-model' });
});
test('B1: native serialization/order remain exact and templates require main, enabled and no tier field', () => {
  const native = [
    { id: 'claude-paid', section: 'main', minimum_tier: 'max' },
    { id: 'claude-disabled', section: 'main', disabled: true },
    { id: 'claude-legacy', section: 'legacy' },
    { id: 'claude-free', section: 'main', thinking: { effort_options: ['low', 'high'] }, notice: 'secret-notice', badge: 'secret-badge', description: 'secret-description', random_marketing: 'secret-marketing', is_default: true },
  ];
  const serialized = native.map(m => JSON.stringify(m));
  const json = { model_selector_config: [{ id: 'code', models: structuredClone(native) }] };
  assert.equal(injectModels(json, state.models), 2);
  assert.deepEqual(json.model_selector_config[0].models.slice(0, native.length).map(m => JSON.stringify(m)), serialized);
  const added = json.model_selector_config[0].models.at(-1);
  assert.equal(JSON.stringify(added).includes('secret'), false); assert.equal(Object.hasOwn(added, 'is_default'), false);
  assert.deepEqual(added.thinking, native[3].thinking);
  for (const models of [native.slice(0, 3), [{ id: 'claude-null-tier', section: 'main', minimum_tier: null }], [{ id: 'claude-no-section' }]]) {
    const status = {}, payload = { model_selector_config: [{ id: 'code', models }] };
    const before = JSON.stringify(payload);
    assert.equal(injectModels(payload, state.models, status), 0);
    assert.equal(status.injection, 'no-eligible-template'); assert.equal(JSON.stringify(payload), before);
  }
});
test('Only a recognized Desktop entrypoint is eligible for routing', () => {
  for (const headers of [{}, { 'x-app': 'claude-desktop' }, { 'user-agent': 'claude-cli/2.1.325 (external, cli)' }, { 'user-agent': 'claude-cli/2.1.325 (external, sdk-cli)' }]) {
    assert.equal(isDesktop(headers), false);
  }
  assert.equal(isDesktop(headers), true);
});
test('C2: exact CA journal is removed only after successful removal; failures preserve it', async t => {
  const d = directory(t), ca = ensureCA(d), cert = new X509Certificate(ca.pem), journal = path.join(d, 'trust.json');
  const save = fingerprint => fs.writeFileSync(journal, JSON.stringify({ fingerprint }));
  save('foreign'); let calls = 0;
  await assert.rejects(clearTrust(d, d, async () => { calls++; }), /fingerprint/); assert.equal(calls, 0);
  save(cert.fingerprint256);
  await assert.rejects(clearTrust(d, d, async () => { throw new Error('denied'); }), /denied/); assert.ok(fs.existsSync(journal));
  await clearTrust(d, d, async (file, home) => { calls++; assert.equal(file, ca.certPath); assert.equal(home, d); });
  assert.equal(calls, 1); assert.equal(fs.existsSync(journal), false);
});

// Exercise the transport without sockets too, so payload/stream behavior is checked
// independently of local port availability.
function request(raw, method = 'POST', url = '/v1/messages', h = {}) {
  const req = Readable.from(raw === undefined ? [] : [Buffer.from(raw)]);
  Object.assign(req, { method, url, headers: h }); return req;
}
function response() {
  const chunks = [], res = new Writable({ write(chunk, enc, cb) { chunks.push(chunk); cb(); } });
  res.writeHead = (status, h) => { res.statusCode = status; res.headers = h; res.headersSent = true; };
  res.payload = () => Buffer.concat(chunks).toString(); return res;
}
function transport(seen) {
  return (url, options, callback) => {
    const chunks = [];
    const out = new Writable({ write(c, enc, cb) { chunks.push(c); cb(); }, final(cb) {
      seen.push({ url: url.toString(), ...options, body: Buffer.concat(chunks) });
      const incoming = Readable.from([Buffer.from('native-stream')]);
      incoming.headers = { 'content-type': 'application/octet-stream' }; incoming.statusCode = 200;
      callback(incoming); cb();
    } });
    out.setTimeout = () => {}; return out;
  };
}
test('A2/A3: ordinary binary bodies and native selector state remain byte exact, Magpie selector state never relays', async () => {
  const seen = [], proxy = new FirstPartyProxy({ state: () => state, upstream: transport(seen) });
  const url = '/api/organizations/private-id/model_selector_state/code';
  for (const raw of ['{"nested":[{"id":"magpie/test/coder"}]}', '{"magpie/test/coder":true}']) {
    const res = response(); await proxy.handle('claude.ai', request(raw, 'PATCH', url), res); assert.equal(res.statusCode, 204);
  }
  assert.equal(proxy.stats.selectorIntercepted, 2); assert.equal(seen.length, 0);
  for (const raw of ['{ "id": "claude-test" }', 'unparseable', '\u0000binary\ufffd']) {
    const res = response(); await proxy.handle('claude.ai', request(raw, 'PATCH', url, { cookie: 'native' }), res);
    assert.equal(seen.at(-1).body.toString(), raw); assert.equal(seen.at(-1).headers.cookie, 'native'); assert.equal(res.payload(), 'native-stream');
  }
});
test('A3: empty GET is explicitly ended, hop headers removed, keep-alive reuse disabled', async () => {
  const seen = [], proxy = new FirstPartyProxy({ state: () => state, upstream: transport(seen) });
  const req = request(undefined, 'GET', '/api/conversations?secret=omit', { expect: '100-continue', te: 'trailers', connection: 'keep-alive, x-hop', 'x-hop': 'remove', cookie: 'native' });
  req.pipe = () => { throw new Error('Empty GET must use end, not pipe'); };
  const res = response(); await proxy.handle('claude.ai', req, res);
  assert.equal(res.statusCode, 200); assert.equal(res.payload(), 'native-stream'); assert.equal(seen[0].agent, false);
  for (const k of ['expect', 'te', 'connection', 'x-hop']) assert.equal(seen[0].headers[k], undefined);
  assert.equal(seen[0].headers.cookie, 'native'); assert.equal(seen[0].body.length, 0);
});
test('A3: failure diagnostics contain only host, method, templated path and safe code', () => {
  const lines = [], proxy = new FirstPartyProxy({ state: () => state, diagnose: line => lines.push(line) });
  proxy.recordFailure('claude.ai', { method: 'GET', url: '/api/organizations/secret-account/conversations/private-chat?token=SECRET' }, { code: 'ECONNRESET', stack: 'SECRET' });
  assert.deepEqual(proxy.stats.lastFailure, { host: 'claude.ai', method: 'GET', path: '/api/organizations/:id/conversations/:id', code: 'ECONNRESET' });
  assert.equal(lines.length, 1); assert.equal(lines[0].includes('SECRET'), false); assert.equal(lines[0].includes('secret-account'), false);
});
test('B3/B4/C4: metadata and account headers never reach Magpie; route reasons count independently', async () => {
  const seen = [], s = { ...state, gateway: 'http://127.0.0.1:12345', key: 'agent-key' };
  const proxy = new FirstPartyProxy({ state: () => s, upstream: transport(seen) });
  const raw = JSON.stringify({ ...body, metadata: { user_id: 'account-secret' } });
  const h = { ...headers, authorization: 'native-secret', cookie: 'cookie-secret', 'x-api-key': 'key-secret' };
  await proxy.handle('api.anthropic.com', request(raw, 'POST', '/v1/messages', h), response());
  assert.equal(seen[0].headers.authorization, 'Bearer agent-key'); assert.equal(seen[0].headers.cookie, undefined); assert.equal(seen[0].headers['x-api-key'], undefined);
  assert.equal(JSON.parse(seen[0].body).metadata, undefined);
  await proxy.handle('api.anthropic.com', request(JSON.stringify({ ...body, model: 'claude-test', tools: [] }), 'POST', '/v1/messages', h), response());
  assert.deepEqual(proxy.stats.lastRoute, { 'desktop-picker': 1, 'native-model': 1 });
});
test('Magpie renders the Agent using its native entry and the Claude icon', () => {
  const pkg = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url)));
  assert.equal(pkg.magpie.agent, './agent.js');
  for (const key of ['panels', 'page', 'actions', 'options']) {
    assert.equal(Object.hasOwn(pkg.magpie, key), false);
  }
  assert.equal(pkg.files.includes('page'), false);
  assert.match(agent.icon, /^data:image\/svg\+xml;base64,/);
});
test('A3: ordinary upload and download stay streaming without JSON parsing', async () => {
  const chunks = []; let incoming;
  const proxy = new FirstPartyProxy({ state: () => state, upstream: (_url, _options, cb) => {
    const out = new Writable({ write(c, enc, done) { chunks.push(c); done(); }, final(done) {
      incoming = new PassThrough(); incoming.statusCode = 200; incoming.headers = { 'content-type': 'text/event-stream' }; cb(incoming);
      incoming.write('first-event'); setImmediate(() => incoming.end('second-event')); done();
    } }); out.setTimeout = () => {}; return out;
  } });
  const raw = Buffer.from([255, 0, 123]); const res = response();
  await proxy.handle('claude.ai', request(raw, 'POST', '/api/ordinary', { 'transfer-encoding': 'chunked' }), res);
  assert.deepEqual(Buffer.concat(chunks), raw); assert.equal(res.payload(), 'first-eventsecond-event');
});

test('C1: unidentified clients bypass request JSON parsing and retain native bytes and credentials', async () => {
  const seen = [], proxy = new FirstPartyProxy({ state: () => state, upstream: transport(seen) });
  const raw = 'not-json';
  await proxy.handle('api.anthropic.com', request(raw, 'POST', '/v1/messages?native=1', { 'content-length': String(raw.length), authorization: 'native-only' }), response());
  assert.equal(seen[0].body.toString(), raw); assert.equal(seen[0].headers.authorization, 'native-only');
  assert.equal(seen[0].url, 'https://api.anthropic.com/v1/messages?native=1');
  assert.equal(proxy.stats.lastRoute['native-non-desktop'], 1);
});
test('B1: nested capability hints are stripped without altering the template', () => {
  const template = { id: 'claude-test', section: 'main', thinking: { enabled: true, notice: 'marketing', effort_options: [{ value: 'high', badge: 'upsell' }] } };
  const original = JSON.stringify(template), json = { model_selector_config: [{ id: 'code', models: [template] }] };
  injectModels(json, [{ id: 'test/coder' }]);
  assert.equal(JSON.stringify(template), original);
  assert.deepEqual(json.model_selector_config[0].models[1].thinking, { enabled: true, effort_options: [{ value: 'high' }] });
});
