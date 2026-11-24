import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { timingSafeEqual } from 'node:crypto';
import { readJson, writeJson, credential } from './files.mjs';
import { ensureCA } from './certificates.mjs';
import { modelList } from './models.mjs';
import { version } from '../package.json' with { type: 'json' };
import { FirstPartyProxy } from './proxy.mjs';
import { DesktopProfile, desktopPaths, assertFirstParty } from './desktop.mjs';
import { trustCA, clearTrust, isTrusted } from './trust.mjs';
import { ClaudeSettings } from './settings.mjs';
import { upstreamProxy } from './upstream.mjs';

const home = process.env.MAGPIE_1P_HOME || os.homedir();
const claude = path.join(home, '.claude');
const stateDir = path.join(claude, 'magpie-1p');
const proxyPort = process.env.MAGPIE_1P_HOME ? Number(process.env.MAGPIE_1P_PROXY_PORT || 3435) : 3435;
const controlPort = process.env.MAGPIE_1P_HOME ? Number(process.env.MAGPIE_1P_CONTROL_PORT || 3436) : 3436;
const proxyURL = 'http://127.0.0.1:' + proxyPort;
const configFile = path.join(claude, 'settings.json');
const connectionFile = path.join(stateDir, 'connection.json');
const settings = new ClaudeSettings(configFile, stateDir);
const token = credential(path.join(stateDir, 'control-token'));
const profile = new DesktopProfile(desktopPaths(home), stateDir);
const leases = new Map();
const statusFile = path.join(stateDir, 'status.json');
let proxy, state, busy = false, stopping = false, trustAttempt = '';
let lastLease = Date.now(), verifiedFingerprint = '';
function restoreWiring() {
  const failures = [];
  for (const restore of [() => profile.disable(), () => settings.disable()]) { try { restore(); } catch (e) { failures.push(e.message); } }
  if (failures.length) throw new Error(failures.join('; '));
}
function report(phase, error = '') {
  if (phase === 'ready-restart-claude' && proxy?.stats.injection === 'no-eligible-template') phase = 'no-eligible-template';
  const status = { runtimeVersion: version, phase, error, pid: process.pid, updatedAt: new Date().toISOString(), models: state?.models?.length || 0, lastRoute: proxy?.stats.lastRoute || {}, stats: proxy?.stats };
  writeJson(statusFile, status);
}
async function reconcile() {
  if (busy || stopping) return;
  busy = true;
  try {
    const env = readJson(configFile, {}).env || {};
    const connection = readJson(connectionFile, {});
    if (connection.key) fs.chmodSync(connectionFile, 0o600);
    if (!connection.key) {
      state = undefined;
      trustAttempt = '';
      restoreWiring();
      if (proxy) { await proxy.close(); proxy = undefined; }
      report('disconnected'); return;
    }
    if (process.platform !== 'darwin') throw new Error('The initial alpha supports macOS only.');
    assertFirstParty(desktopPaths(home), env);
    const gateway = new URL(connection.gateway);
    if (!['127.0.0.1', 'localhost', '[::1]'].includes(gateway.hostname) || gateway.protocol !== 'http:' || gateway.username || gateway.password || gateway.search || gateway.hash) throw new Error('A local HTTP Magpie gateway is required.');
    state = {
      key: connection.key,
      gateway: gateway.toString().replace(/\/$/, ''),
      models: modelList({ MAGPIE_1P_MODELS: JSON.stringify(connection.models || []) }),
    };
    if (!proxy) {
      const ca = ensureCA(stateDir);
      const next = new FirstPartyProxy({ ca, state: () => state, upstreamProxy: upstreamProxy(process.env, [proxyPort]), diagnose: line => fs.appendFileSync(path.join(stateDir, 'runtime.log'), line + '\n', { mode: 0o600 }) });
      await next.listen(proxyPort); proxy = next;
    }
    const trustFile = path.join(stateDir, 'trust.json');
    const caFile = path.join(stateDir, 'ca.pem');
    const fingerprint = new (await import('node:crypto')).X509Certificate(fs.readFileSync(caFile)).fingerprint256;
    const saved = readJson(trustFile, {});
    if (saved.fingerprint === fingerprint && verifiedFingerprint !== fingerprint && await isTrusted(caFile)) verifiedFingerprint = fingerprint;
    if (verifiedFingerprint !== fingerprint) {
      if (trustAttempt === fingerprint) {
        report('needs-trust', 'Local certificate trust failed. Disconnect and reconnect the agent in Magpie to retry.');
        return;
      }
      trustAttempt = fingerprint;
      report('awaiting-system-trust');
      try { await trustCA(caFile, home); }
      catch { report('needs-trust', 'Local certificate trust failed. Disconnect and reconnect the agent in Magpie to retry.'); return; }
      verifiedFingerprint = fingerprint;
      writeJson(trustFile, { fingerprint });
    }
    profile.enable(proxyURL);
    settings.enable(proxyURL, path.join(stateDir, 'ca.pem'));
    report('ready-restart-claude');
  } catch (e) {
    state = undefined;
    // A malformed/foreign config must never keep advertising Magpie models.
    try { restoreWiring(); } catch { /* Ownership conflicts remain for manual review. */ }
    report('error', String(e.message || e));
  } finally { busy = false; }
}
const control = http.createServer(async (req, res) => {
  const supplied = String(req.headers.authorization || '');
  const expected = 'Bearer ' + token;
  if (req.headers.origin || supplied.length !== expected.length || !timingSafeEqual(Buffer.from(supplied), Buffer.from(expected))) { res.writeHead(403); res.end(); return; }
  if (req.method === 'GET' && req.url === '/status') { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(readJson(statusFile, {}))); return; }
  if (req.method !== 'POST' || req.url !== '/lease') { res.writeHead(404); res.end(); return; }
  try {
    const chunks = []; let size = 0;
    for await (const chunk of req) { size += chunk.length; if (size > 65536) throw new Error('Oversize lease'); chunks.push(chunk); }
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (typeof body.id !== 'string' || !/^[a-zA-Z0-9-]{1,100}$/.test(body.id)) throw new Error('Invalid lease');
    if (body.release) leases.delete(body.id);
    else { lastLease = Date.now(); leases.set(body.id, lastLease); }
    res.end('{}');
  } catch { res.writeHead(400); res.end(); }
});
control.on('error', e => {
  if (e.code === 'EADDRINUSE') process.exit(0); // The elected worker already owns this address.
  process.exitCode = 1;
});
control.listen(controlPort, '127.0.0.1', () => report('starting'));
const timer = setInterval(() => {
  for (const [id, at] of leases) if (Date.now() - at > 20000) leases.delete(id);
  if (!leases.size && Date.now() - lastLease > 25000) { void shutdown(); return; }
  if (leases.size) void reconcile();
}, 1000);
async function shutdown() {
  if (stopping) return;
  stopping = true; clearInterval(timer);
  // A trust dialog can still be open; wait for reconciliation before removing its profile.
  while (busy) await new Promise(resolve => setTimeout(resolve, 100));
  const errors = [];
  try { restoreWiring(); } catch (e) { errors.push(e.message); }
  try { if (proxy) await proxy.close(); } catch (e) { errors.push(e.message); }
  if (fs.existsSync(path.join(stateDir, 'trust.json'))) {
    try { await clearTrust(stateDir, home); }
    catch { errors.push('Exact local CA removal needs attention; trust journal retained.'); }
  }
  report(errors.length ? 'cleanup-error' : 'stopped', errors.join('; '));
  control.close(() => process.exit());
  setTimeout(() => process.exit(), 2000).unref();
}
process.on('SIGTERM', shutdown); process.on('SIGINT', shutdown);
