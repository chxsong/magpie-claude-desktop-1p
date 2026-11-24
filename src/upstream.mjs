import net from 'node:net';
import tls from 'node:tls';

// Desktop and the Magpie host inherit the user's own proxy (e.g. a system proxy on
// 127.0.0.1:7890). Native Anthropic traffic must keep using it, or it fails where a
// direct connection is blocked. Only plain http:// CONNECT proxies are supported.
export function upstreamProxy(env = process.env, self = []) {
  const raw = env.MAGPIE_1P_UPSTREAM_PROXY ?? env.HTTPS_PROXY ?? env.https_proxy ?? env.ALL_PROXY ?? env.all_proxy ?? '';
  if (!raw) return null;
  let url;
  try { url = new URL(raw); } catch { return null; }
  if (url.protocol !== 'http:' || !url.hostname) return null;
  const port = Number(url.port || 80);
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (['127.0.0.1', 'localhost', '::1'].includes(host) && self.map(Number).includes(port)) return null; // Never loop into ourselves.
  const auth = url.username ? 'Basic ' + Buffer.from(decodeURIComponent(url.username) + ':' + decodeURIComponent(url.password)).toString('base64') : '';
  return { host, port, auth };
}

// Resolves with a connected raw TCP socket to host:port, via the upstream proxy when set.
export function openTunnel(proxy, host, port, timeout = 15000) {
  return new Promise((resolve, reject) => {
    const socket = net.connect(proxy ? { host: proxy.host, port: proxy.port } : { host, port });
    const fail = e => { socket.destroy(); reject(e); };
    socket.setTimeout(timeout, () => fail(Object.assign(new Error('Connection timed out'), { code: 'ETIMEDOUT' })));
    socket.once('error', fail);
    socket.once('connect', () => {
      if (!proxy) { socket.setTimeout(0); socket.removeListener('error', fail); resolve(socket); return; }
      socket.write(`CONNECT ${host}:${port} HTTP/1.1\r\nHost: ${host}:${port}\r\n${proxy.auth ? 'Proxy-Authorization: ' + proxy.auth + '\r\n' : ''}\r\n`);
      let buffer = Buffer.alloc(0);
      const onData = chunk => {
        buffer = Buffer.concat([buffer, chunk]);
        const end = buffer.indexOf('\r\n\r\n');
        if (end < 0) { if (buffer.length > 16384) fail(new Error('Upstream proxy header too large')); return; }
        socket.removeListener('data', onData);
        const status = /^HTTP\/1\.[01] (\d{3})/.exec(buffer.subarray(0, end).toString('latin1'))?.[1];
        if (status !== '200') { fail(Object.assign(new Error('Upstream proxy refused CONNECT'), { code: 'UPSTREAM_PROXY_' + (status || 'BAD') })); return; }
        socket.pause();
        const rest = buffer.subarray(end + 4);
        if (rest.length) socket.unshift(rest);
        socket.setTimeout(0); socket.removeListener('error', fail);
        resolve(socket);
      };
      socket.on('data', onData);
    });
  });
}

// Request options that send an https request over an already-open tunnel.
export async function httpsOver(proxy, url) {
  if (!proxy) return {};
  const socket = await openTunnel(proxy, url.hostname, Number(url.port || 443));
  return { createConnection: () => tls.connect({ socket, servername: url.hostname, ALPNProtocols: ['http/1.1'] }) };
}
