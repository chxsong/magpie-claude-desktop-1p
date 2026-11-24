import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import tls from 'node:tls';
import zlib from 'node:zlib';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

async function tunnel(port, host, ca, originPort) {
  const debug = (...x) => { if (process.env.DEBUG_TEST) console.error(...x); };
  debug('tunnel', host);
  const socket = net.connect(port, '127.0.0.1');
  await new Promise((resolve, reject) => { socket.once('connect', resolve); socket.once('error', reject); });
  debug('tcp connected');
  socket.write(`CONNECT ${host}:${originPort} HTTP/1.1\r\nHost: ${host}:${originPort}\r\n\r\n`);
  await new Promise((resolve, reject) => {
    const data = chunk => { if (!chunk.toString().includes('200 Connection Established')) reject(new Error('CONNECT failed')); else { socket.off('data', data); resolve(); } };
    socket.on('data', data); socket.once('error', reject);
  });
  debug('CONNECT accepted');
  const secure = tls.connect({ socket, servername: host, ca, rejectUnauthorized: true });
  await new Promise((resolve, reject) => { secure.once('secureConnect', resolve); secure.once('error', reject); });
  debug('TLS ready');
  return secure;
}
async function call(port, host, ca, url, body, headers = {}, method, originPort = 443) {
  const socket = await tunnel(port, host, ca, originPort);
  return new Promise((resolve, reject) => {
    const data = body === undefined ? undefined : Buffer.isBuffer(body) ? body : Buffer.from(JSON.stringify(body));
    const all = { host, 'user-agent': 'claude-cli/2.1.325 (external, claude-desktop)', ...headers, ...(data ? { 'content-length': data.length } : {}), connection: 'close' };
    const parts = []; let done = false;
    function parse(ended = false) {
      if (done) return;
      try {
        const raw = Buffer.concat(parts), split = raw.indexOf('\r\n\r\n');
        if (split < 0) return;
        const lines = raw.subarray(0, split).toString().split('\r\n');
        const status = Number(lines.shift().split(' ')[1]);
        const incoming = Object.fromEntries(lines.map(line => { const i = line.indexOf(':'); return [line.slice(0, i).toLowerCase(), line.slice(i + 1).trim()]; }));
        let payload = raw.subarray(split + 4);
        if (incoming['transfer-encoding'] === 'chunked') {
          const chunks = []; let cursor = 0;
          for (;;) {
            const end = payload.indexOf('\r\n', cursor); if (end < 0) return;
            const length = parseInt(payload.subarray(cursor, end).toString().split(';')[0], 16);
            assert.ok(Number.isFinite(length)); cursor = end + 2;
            if (!length) { if (payload.length < cursor + 2) return; break; }
            if (payload.length < cursor + length + 2) return;
            chunks.push(payload.subarray(cursor, cursor + length)); cursor += length + 2;
          }
          payload = Buffer.concat(chunks);
        } else if (incoming['content-length'] !== undefined) {
          const length = Number(incoming['content-length']);
          if (payload.length < length) return;
          payload = payload.subarray(0, length);
        } else if (!ended) return;
        done = true; socket.destroy(); resolve({ status, headers: incoming, body: payload });
      } catch (e) { done = true; socket.destroy(); reject(e); }
    }
    socket.on('data', chunk => { parts.push(chunk); parse(); });
    socket.once('error', reject);
    socket.setTimeout(5000, () => socket.destroy(new Error('Test HTTP response timed out')));
    socket.once('end', () => parse(true));
    socket.write(`${method || (data ? 'POST' : 'GET')} ${url} HTTP/1.1\r\n${Object.entries(all).map(([k, v]) => k + ': ' + v).join('\r\n')}\r\n\r\n`);
    if (data) socket.write(data);
  });
}

async function fixture(t, runtime) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'magpie-1p-proxy-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const child = spawn(runtime, [fileURLToPath(new URL('./fixtures/server.mjs', import.meta.url)), dir], { env: { ...process.env, HOME: dir, MAGPIE_1P_HOME: dir, MAGPIE_1P_SANDBOX: '1' }, stdio: ['ignore', 'pipe', 'pipe'] });
  let stderr = '';
  child.stderr.on('data', c => { stderr += c; if (process.env.DEBUG_TEST) console.error(c.toString()); });
  t.after(async () => {
    if (child.exitCode !== null) return;
    child.kill('SIGTERM');
    await new Promise(resolve => { child.once('exit', resolve); setTimeout(() => { child.kill('SIGKILL'); resolve(); }, 3000).unref(); });
  });
  const info = await new Promise((resolve, reject) => {
    let out = '';
    child.once('error', reject);
    child.once('exit', code => reject(new Error(`Fixture exited ${code}: ${stderr}`)));
    child.stdout.on('data', c => { out += c; const i = out.indexOf('\n'); if (i >= 0) { try { resolve(JSON.parse(out.slice(0, i))); } catch (e) { reject(e); } } });
  });
  return info;
}

for (const runtime of ['node', 'bun']) test(`Real CONNECT/TLS through ${runtime}: native, SSE/tools, gzip picker, credential separation`, { timeout: 15000 }, async t => {
  const { port, gwPort, ca } = await fixture(t, runtime);
  const secretHeaders = { authorization: 'Bearer CLAUDE-SECRET', cookie: 'session=CLAUDE-COOKIE', 'x-api-key': 'CLAUDE-KEY', 'anthropic-version': '2023-06-01' };
  const native = Buffer.from('{ "model": "claude-test", "messages": [] }');
  assert.equal((await call(port, 'api.anthropic.com', ca, '/v1/messages', native, secretHeaders)).status, 200);
  const answer = await call(port, 'api.anthropic.com', ca, '/v1/messages?beta=true', { model: 'magpie/test/coder@high', stream: true, messages: [], metadata: { user_id: 'PRIVATE-ACCOUNT' } }, secretHeaders);
  assert.equal(answer.status, 200); assert.match(answer.body.toString(), /tool_use/); assert.match(answer.body.toString(), /message_stop/);
  const boot = await call(port, 'claude.ai', ca, '/api/bootstrap', undefined, { cookie: 'native-cookie', 'if-none-match': 'old', 'if-modified-since': 'Tue, 17 Nov 2026 00:00:00 GMT', 'accept-encoding': 'gzip, br, zstd' });
  assert.equal(boot.status, 200);
  assert.equal(boot.headers['content-encoding'], undefined); assert.equal(boot.headers.etag, undefined);
  const json = JSON.parse(boot.body);
  assert.equal(json.model_selector_config[0].models.length, 1); assert.equal(json.model_selector_config[1].models[1].id, 'magpie/test/coder');
  assert.equal((await call(port, 'api.anthropic.com', ca, '/v1/messages', { model: 'magpie/missing', messages: [] })).status, 404);
  const inspection = await fetch(`http://127.0.0.1:${gwPort}/inspect`).then(r => r.json());
  const { seen, origins } = inspection;
  assert.equal(origins[0].body, native.toString()); assert.equal(origins[0].headers.authorization, secretHeaders.authorization);
  assert.equal(seen[0].headers.authorization, 'Bearer magpie-agent-only');
  assert.equal(seen[0].headers.cookie, undefined); assert.equal(seen[0].headers['x-api-key'], undefined);
  assert.equal(seen[0].body.model, 'test/coder'); assert.equal(seen[0].body.output_config.effort, 'high');
  assert.equal(seen[0].url, '/v1/messages'); assert.equal(seen[0].body.metadata, undefined);
  assert.equal(origins[1].headers['if-none-match'], undefined); assert.equal(origins[1].headers['if-modified-since'], undefined); assert.equal(origins[1].headers['accept-encoding'], 'identity');
  assert.equal(origins.length, 2); assert.equal(seen.length, 1);
});

for (const runtime of ['node', 'bun']) test(`Nonstandard CONNECT ports stay opaque through ${runtime}`, { timeout: 15000 }, async t => {
  const { port, originCA } = await fixture(t, runtime);
  const boot = await call(port, 'claude.ai', originCA, '/api/bootstrap', undefined, {}, 'GET', 9443);
  assert.equal(boot.status, 200);
  assert.equal(boot.headers['content-encoding'], 'gzip');
  assert.equal(JSON.parse(zlib.gunzipSync(boot.body)).model_selector_config[1].models.length, 1);
  const cached = await call(port, 'claude.ai', originCA, '/api/bootstrap', undefined, { 'if-none-match': 'old' }, 'GET', 9443);
  assert.equal(cached.status, 304);
});

for (const runtime of ['node', 'bun']) test(`Ordinary claude.ai GET through ${runtime}`, { timeout: 15000 }, async t => {
  const { port, gwPort, ca } = await fixture(t, runtime);
  for (let i = 0; i < 5; i++) {
    const response = await call(port, 'claude.ai', ca, '/api/organizations/private-id/conversations?secret=omit');
    assert.equal(response.status, 200, response.body.toString());
  }
});

for (const runtime of ['node', 'bun']) test(`Selector state interception and ordinary payloads through ${runtime}`, { timeout: 15000 }, async t => {
  const { port, gwPort, ca } = await fixture(t, runtime);
  const url = '/api/organizations/private-id/model_selector_state/code';
  assert.equal((await call(port, 'claude.ai', ca, url, { nested: [{ selected: 'magpie/test/coder' }] }, {}, 'PATCH')).status, 204);
  const native = Buffer.from('{ "selected": "claude-test" }');
  assert.equal((await call(port, 'claude.ai', ca, url, native, { cookie: 'native-cookie' }, 'PATCH')).status, 200);
  const binary = Buffer.from([0, 255, 1, 123]);
  assert.equal((await call(port, 'claude.ai', ca, '/api/other', binary)).status, 200);
  const { origins, seen } = await fetch(`http://127.0.0.1:${gwPort}/inspect`).then(r => r.json());
  assert.equal(origins.length, 2); assert.equal(seen.length, 0);
  assert.equal(origins[0].body, native.toString()); assert.equal(origins[0].headers.cookie, 'native-cookie');
  assert.equal(origins[1].body, binary.toString());
});
