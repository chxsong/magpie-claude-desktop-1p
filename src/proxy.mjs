import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import zlib from 'node:zlib';
import { injectModels } from './models.mjs';
import { isDesktop, resolveModel } from './routing.mjs';
import { openTunnel, httpsOver } from './upstream.mjs';
const LIMIT = 32 * 1024 * 1024;
const HOP = new Set(['connection', 'proxy-connection', 'proxy-authorization', 'keep-alive', 'transfer-encoding', 'upgrade', 'host', 'te', 'trailer', 'expect']);
function headersOf(headers) {
  const skip = new Set([...HOP, ...String(headers.connection || '').toLowerCase().split(',').map(s => s.trim())]);
  return Object.fromEntries(Object.entries(headers).filter(([k]) => !skip.has(k.toLowerCase())));
}
async function bytes(stream) {
  const chunks = []; let size = 0;
  for await (const chunk of stream) { size += chunk.length; if (size > LIMIT) throw new Error('Body exceeds 32 MiB'); chunks.push(chunk); }
  return Buffer.concat(chunks);
}
function decode(raw, encoding) {
  const options = { maxOutputLength: LIMIT };
  if (!encoding || encoding === 'identity') return raw;
  if (encoding === 'gzip') return zlib.gunzipSync(raw, options);
  if (encoding === 'br') return zlib.brotliDecompressSync(raw, options);
  if (encoding === 'deflate') return zlib.inflateSync(raw, options);
  throw new Error('Unsupported content encoding');
}
function error(res, status, message) {
  if (res.headersSent) { res.destroy(); return; }
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ type: 'error', error: { type: status === 400 ? 'invalid_request_error' : 'api_error', message } }));
}
export class FirstPartyProxy {
  constructor({ ca, state, upstream, tunnelConnect, upstreamProxy = null, diagnose = line => console.error(line) }) {
    this.ca = ca; this.state = state; this.diagnose = diagnose;
    // Injectable transport used only by integration tests; production validates origin TLS normally.
    this.upstream = upstream;
    this.upstreamProxy = upstreamProxy;
    this.tunnelConnect = tunnelConnect;
    this.sockets = new Set(); this.interceptors = new Map();
    this.stats = { routed: 0, injected: 0, failures: 0, bootstrapSeen: 0, bootstrapStatus: null, lastFailure: null, selectorIntercepted: 0, lastRoute: {} };
    this.server = http.createServer((req, res) => { error(res, 400, 'Use an HTTPS CONNECT proxy'); });
    this.server.on('connect', (req, socket, head) => { void this.connect(req, socket, head).catch(() => socket.destroy()); });
    this.server.on('clientError', (_err, socket) => socket.destroy());
    this.server.on('connection', socket => this.track(socket));
  }
  track(socket) { this.sockets.add(socket); socket.once('close', () => this.sockets.delete(socket)); socket.on('error', () => {}); }
  async listen(port = 3435) {
    await new Promise((resolve, reject) => { this.server.once('error', reject); this.server.listen(port, '127.0.0.1', resolve); });
    return this.server.address().port;
  }
  async connect(req, socket, head) {
    let url;
    try { url = new URL('https://' + req.url); if (url.username || url.password || url.pathname !== '/' || url.search || url.hash) throw new Error(); }
    catch { socket.end('HTTP/1.1 400 Bad Request\r\n\r\n'); return; }
    const host = url.hostname.replace(/^\[|\]$/g, ''), port = Number(url.port || 443);
    const intercept = port === 443 && (host === 'api.anthropic.com' || host === 'claude.ai');
    if (!intercept) {
      if (this.tunnelConnect) {
        const remote = this.tunnelConnect(host, port); this.track(remote);
        remote.once('connect', () => { socket.write('HTTP/1.1 200 Connection Established\r\n\r\n'); if (head.length) remote.write(head); socket.pipe(remote).pipe(socket); });
        remote.once('error', () => socket.destroy()); socket.once('close', () => remote.destroy());
        return;
      }
      let remote;
      try { remote = await openTunnel(this.upstreamProxy, host, port); }
      catch { socket.end('HTTP/1.1 502 Bad Gateway\r\n\r\n'); return; }
      this.track(remote); remote.on('error', () => socket.destroy()); socket.once('close', () => remote.destroy());
      socket.write('HTTP/1.1 200 Connection Established\r\n\r\n'); if (head.length) remote.write(head);
      socket.pipe(remote).pipe(socket); remote.resume();
      return;
    }
    if (!this.interceptors.has(host)) {
      this.interceptors.set(host, (async () => {
        const server = https.createServer({ ...this.ca.leaf(host), ALPNProtocols: ['http/1.1'], minVersion: 'TLSv1.2' }, (req, res) => {
          void this.handle(host, req, res).catch(e => { this.recordFailure(host, req, e); error(res, 502, 'Magpie 1P proxy request failed; check the local status file.'); });
        });
        server.on('connection', socket => this.track(socket));
        server.on('tlsClientError', (_e, socket) => socket.destroy());
        await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
        return server;
      })());
    }
    // A real loopback TLS listener works on both Bun and Node; no private TLS internals.
    const server = await this.interceptors.get(host);
    const remote = net.connect(server.address().port, '127.0.0.1'); this.track(remote);
    remote.once('connect', () => {
      socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head.length) remote.write(head);
      socket.pipe(remote).pipe(socket);
    });
    remote.once('error', () => socket.destroy()); socket.once('close', () => remote.destroy());
  }

  recordFailure(host, req, e) {
    // Template all dynamic segments; never retain queries, credentials, UUIDs or stacks.
    const known = new Set(['api', 'edge-api', 'bootstrap', 'organizations', 'conversations', 'model_selector_state', 'code', 'v1', 'messages', 'count_tokens']);
    const pathname = String(req.url || '/').split('?')[0].split('/').map(s => !s || known.has(s) ? s : ':id').join('/');
    const code = /^[A-Z_0-9]{1,40}$/.test(e.code || '') ? e.code : 'UPSTREAM_ERROR';
    this.stats.failures++;
    this.stats.lastFailure = { host, method: req.method, path: pathname, code };
    try { this.diagnose(JSON.stringify(this.stats.lastFailure)); } catch { /* Retain status diagnostics even when the log is unavailable. */ }
  }
  async handle(host, req, res) {
    const pathname = (req.url || '/').split('?')[0];
    const state = this.state();
    if (host === 'api.anthropic.com' && req.method === 'POST' && ['/v1/messages', '/v1/messages/count_tokens'].includes(pathname)) {
      if (!isDesktop(req.headers)) {
        this.stats.lastRoute['native-non-desktop'] = (this.stats.lastRoute['native-non-desktop'] || 0) + 1;
        await this.relay(this.origin(host, req.url), req, res, headersOf(req.headers), undefined, false); return;
      }
      const raw = await bytes(req);
      let body;
      try { body = JSON.parse(decode(raw, req.headers['content-encoding']).toString('utf8')); }
      catch { error(res, 400, 'Invalid or oversized Anthropic request body'); return; }
      const decision = resolveModel(body?.model, state?.models || []);
      const reason = decision.reason || (decision.error ? 'refused' : 'native');
      this.stats.lastRoute[reason] = (this.stats.lastRoute[reason] || 0) + 1;
      if (decision.error) { error(res, decision.status || 400, decision.error); return; }
      const target = decision.target;
      if (target) {
        if (!state?.key || !state.gateway) { error(res, 503, 'Magpie 1P is disconnected'); return; }
        const destination = new URL(state.gateway);
        if (!['127.0.0.1', 'localhost', '[::1]'].includes(destination.hostname) || destination.protocol !== 'http:') { error(res, 502, 'Only the local HTTP Magpie gateway is supported'); return; }
        destination.pathname = destination.pathname.replace(/\/$/, '') + pathname;
        destination.search = ''; destination.hash = '';
        const effort = String(body.model).match(/@(low|medium|high|xhigh|max|ultra|minimal|none)$/)?.[1];
        const { metadata: _metadata, ...safeBody } = body;
        const payload = Buffer.from(JSON.stringify({ ...safeBody, model: target, ...(effort ? { output_config: { ...body.output_config, effort } } : {}) }));
        // Explicit allowlist: Claude subscription cookies and authorization never reach Magpie.
        const out = { 'content-type': 'application/json', 'content-length': payload.length, authorization: 'Bearer ' + state.key };
        for (const key of ['anthropic-version', 'anthropic-beta', 'x-claude-code-session-id', 'x-claude-code-request-class']) if (req.headers[key]) out[key] = req.headers[key];
        this.stats.routed++;
        await this.relay(destination, req, res, out, payload, false);
        return;
      }
      await this.relay(this.origin(host, req.url), req, res, headersOf(req.headers), raw, false);
      return;
    }
    if (host === 'claude.ai' && req.method === 'PATCH' && /^\/api\/organizations\/[^/]+\/model_selector_state\/code$/.test(pathname)) {
      const raw = await bytes(req);
      let intercepted = false;
      try {
        const contains = v => typeof v === 'string' ? v.startsWith('magpie/') : v && typeof v === 'object' && Object.entries(v).some(([k, value]) => k.startsWith('magpie/') || contains(value));
        intercepted = contains(JSON.parse(decode(raw, req.headers['content-encoding']).toString('utf8')));
      } catch { /* Unknown payloads stay unchanged. */ }
      if (intercepted) { this.stats.selectorIntercepted++; res.writeHead(204); res.end(); return; }
      await this.relay(this.origin(host, req.url), req, res, headersOf(req.headers), raw, false); return;
    }
    const bootstrap = host === 'claude.ai' && req.method === 'GET' && /^\/(edge-api|api)\/bootstrap(?:\/|$)/.test(pathname);
    const outgoing = headersOf(req.headers);
    if (bootstrap) {
      this.stats.bootstrapSeen++;
      // A cached native bootstrap has no body to inject. Always retrieve its current JSON.
      delete outgoing['if-none-match']; delete outgoing['if-modified-since'];
      outgoing['cache-control'] = 'no-cache';
      outgoing['accept-encoding'] = 'identity';
    }
    await this.relay(this.origin(host, req.url), req, res, outgoing, undefined, bootstrap);
  }
  origin(host, url) {
    // The CONNECT target owns the host. Absolute paths and a hostile Host header cannot change it.
    const result = new URL('https://' + host);
    const relative = String(url || '/');
    if (!relative.startsWith('/') || relative.startsWith('//')) throw new Error('Invalid origin-form path');
    const i = relative.indexOf('?');
    result.pathname = i < 0 ? relative : relative.slice(0, i); result.search = i < 0 ? '' : relative.slice(i);
    return result;
  }
  async relay(url, req, res, headers, body, bootstrap) {
    const lib = url.protocol === 'https:' ? https : http;
    const via = !this.upstream && url.protocol === 'https:' ? await httpsOver(this.upstreamProxy, url) : {};
    await new Promise((resolve, reject) => {
      const out = (this.upstream || ((url, options, cb) => lib.request(url, options, cb)))(url, { method: req.method, headers, agent: false, ...via }, async incoming => {
        try {
          let responseHeaders = headersOf(incoming.headers);
          if (bootstrap) this.stats.bootstrapStatus = incoming.statusCode;
          if (bootstrap && incoming.statusCode === 200) {
            const raw = await bytes(incoming);
            let payload = raw;
            try {
              const json = JSON.parse(decode(raw, incoming.headers['content-encoding']).toString('utf8'));
              const current = this.state();
              const count = injectModels(json, current?.models || [], this.stats);
              if (count) {
                this.stats.injected += count;
                payload = Buffer.from(JSON.stringify(json));
                for (const k of ['content-encoding', 'content-length', 'etag', 'content-md5', 'digest']) delete responseHeaders[k];
                responseHeaders['content-length'] = String(payload.length);
                responseHeaders['cache-control'] = 'no-store';
              }
            } catch { /* An unknown bootstrap schema stays byte-for-byte native. */ }
            res.writeHead(incoming.statusCode, responseHeaders); res.end(payload); resolve();
          } else {
            res.writeHead(incoming.statusCode || 502, responseHeaders);
            incoming.once('error', reject); incoming.once('end', resolve); incoming.pipe(res);
          }
        } catch (e) { incoming.destroy(); reject(e); }
      });
      out.once('error', reject);
      out.setTimeout(300000, () => out.destroy(new Error('Upstream timed out')));
      res.once('close', () => { if (!res.writableFinished) out.destroy(); });
      req.once('aborted', () => out.destroy());
      if (body !== undefined) out.end(body);
      else if (req.readableEnded || ((!req.headers['content-length'] || req.headers['content-length'] === '0') && !req.headers['transfer-encoding'])) out.end();
      else { req.once('error', e => out.destroy(e)); req.pipe(out); }
    });
  }
  async close() {
    for (const socket of this.sockets) socket.destroy();
    await new Promise(resolve => this.server.close(resolve));
    for (const pending of this.interceptors.values()) {
      const server = await pending.catch(() => null);
      if (server) await new Promise(resolve => server.close(resolve));
    }
  }
}
