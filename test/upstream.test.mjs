import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import http from 'node:http';
import { upstreamProxy, openTunnel } from '../src/upstream.mjs';

test('Upstream proxy is read from env and never loops into the 1P proxy', () => {
  assert.deepEqual(upstreamProxy({ HTTPS_PROXY: 'http://127.0.0.1:7890' }, [3435]), { host: '127.0.0.1', port: 7890, auth: '' });
  assert.equal(upstreamProxy({ HTTPS_PROXY: 'http://127.0.0.1:3435' }, [3435]), null);
  assert.equal(upstreamProxy({ HTTPS_PROXY: 'socks5://127.0.0.1:7891' }, [3435]), null);
  assert.equal(upstreamProxy({}, [3435]), null);
});

test('Tunnels go through the upstream CONNECT proxy', async t => {
  const echo = net.createServer(s => s.pipe(s)); await new Promise(r => echo.listen(0, '127.0.0.1', r));
  const seen = [];
  const proxy = http.createServer(); proxy.on('connect', (req, sock) => {
    seen.push(req.url); const [h, p] = req.url.split(':');
    const up = net.connect(Number(p), h, () => { sock.write('HTTP/1.1 200 OK\r\n\r\n'); sock.pipe(up).pipe(sock); });
  });
  await new Promise(r => proxy.listen(0, '127.0.0.1', r));
  t.after(() => { echo.close(); proxy.close(); });
  const socket = await openTunnel({ host: '127.0.0.1', port: proxy.address().port, auth: '' }, '127.0.0.1', echo.address().port);
  socket.resume();
  const reply = new Promise(r => socket.once('data', d => r(String(d))));
  socket.write('ping'); assert.equal(await reply, 'ping');
  assert.deepEqual(seen, ['127.0.0.1:' + echo.address().port]);
  socket.destroy();
});
