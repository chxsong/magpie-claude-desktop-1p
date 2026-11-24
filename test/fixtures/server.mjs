import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import path from 'node:path';
import zlib from 'node:zlib';
import { ensureCA } from '../../src/certificates.mjs';
import { FirstPartyProxy } from '../../src/proxy.mjs';
const ca = ensureCA(process.argv[2]), seen = [], origins = [];
const listen = s => new Promise((resolve, reject) => { s.once('error', reject); s.listen(0, '127.0.0.1', () => resolve(s.address().port)); });
const gateway = http.createServer(async (req, res) => {
  if (req.url === '/inspect') { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ seen, origins })); return; }
  const chunks = []; for await (const c of req) chunks.push(c);
  seen.push({ url: req.url, headers: req.headers, body: JSON.parse(Buffer.concat(chunks)) });
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  res.write('event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"tool_1","name":"read_file","input":{}}}\n\n');
  res.end('event: message_stop\ndata: {"type":"message_stop"}\n\n');
});
const gwPort = await listen(gateway);
const originHandler = async (req, res) => {
  const chunks = []; for await (const c of req) chunks.push(c);
  if (process.env.DEBUG_TEST) console.error('origin received');
  origins.push({ url: req.url, headers: req.headers, body: Buffer.concat(chunks).toString() });
  if (req.url.startsWith('/api/bootstrap')) {
    if (req.headers['if-none-match'] || req.headers['if-modified-since']) { res.writeHead(304, { etag: 'old' }); res.end(); return; }
    const json = { model_selector_config: ['chat', 'code'].map(id => ({ id, models: [{ id: 'claude-test', name: 'Claude', section: 'main' }] })) };
    res.writeHead(200, { 'content-encoding': 'gzip', 'content-type': 'application/json', etag: 'old' }); res.end(zlib.gzipSync(JSON.stringify(json)));
  } else res.end('{"native":true}');
};
const origin = http.createServer(originHandler);
const originPort = await listen(origin);
const originCA = ensureCA(path.join(process.argv[2], 'upstream-ca'));
const tlsOrigin = https.createServer(originCA.leaf('claude.ai'), originHandler);
const tlsOriginPort = await listen(tlsOrigin);
const state = { key: 'magpie-agent-only', gateway: `http://127.0.0.1:${gwPort}`, models: [{ id: 'test/coder', name: 'Coder' }, { id: 'test/other', name: 'Other' }] };
const proxy = new FirstPartyProxy({ ca, state: () => state, tunnelConnect: (host, port) => { if (host !== 'claude.ai' || port !== 9443) throw new Error('Unexpected test destination'); return net.connect(tlsOriginPort, '127.0.0.1'); }, upstream: (url, options, callback) => http.request({ ...options, hostname: '127.0.0.1', port: url.hostname === '127.0.0.1' ? url.port : originPort, path: url.pathname + url.search }, callback) });
const handle = proxy.handle.bind(proxy);
proxy.handle = (host, req, res) => { if (process.env.DEBUG_TEST) console.error('handle', host, req.url); return handle(host, req, res); };
const port = await proxy.listen(0);
process.stdout.write(JSON.stringify({ port, gwPort, ca: ca.pem, originCA: originCA.pem }) + '\n');
process.on('SIGTERM', async () => { await proxy.close(); gateway.close(); origin.close(); tlsOrigin.close(); process.exit(); });
