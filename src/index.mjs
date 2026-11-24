import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { credential } from './files.mjs';

// This is the only plugin function exported. Magpie calls every exported function.
export default async function ClaudeFirstParty() {
  if (process.platform !== 'darwin') throw new Error('Claude Desktop 1P alpha currently supports macOS only.');
  const home = process.env.MAGPIE_1P_HOME || os.homedir();
  const dir = path.join(home, '.claude/magpie-1p');
  const key = credential(path.join(dir, 'control-token'));
  const controlPort = process.env.MAGPIE_1P_HOME ? Number(process.env.MAGPIE_1P_CONTROL_PORT || 3436) : 3436;
  const id = crypto.randomUUID();
  let starting = false, closed = false, lastLaunch = 0;
  function lease() {
    return new Promise((resolve, reject) => {
      const body = JSON.stringify({ id });
      const req = http.request({ hostname: '127.0.0.1', port: controlPort, path: '/lease', method: 'POST', headers: { authorization: 'Bearer ' + key, 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) }, timeout: 1500 }, res => {
        res.resume(); res.once('end', () => res.statusCode === 200 ? resolve() : reject(new Error('The 1P service port belongs to another process.')));
      });
      req.once('error', reject); req.once('timeout', () => req.destroy(new Error('1P lease timeout'))); req.end(body);
    });
  }
  async function heartbeat() {
    if (starting || closed) return;
    starting = true;
    try { await lease(); }
    catch (e) {
      if (e.code !== 'ECONNREFUSED' || Date.now() - lastLaunch < 15000) { console.error('[Claude 1P]', e.message); return; }
      lastLaunch = Date.now();
      const runtime = process.execPath; // Magpie's own Bun. No separate Node installation.
      const worker = fileURLToPath(new URL('./worker.mjs', import.meta.url));
      const log = fs.openSync(path.join(dir, 'runtime.log'), 'a', 0o600);
      const child = spawn(runtime, [worker], { detached: true, stdio: ['ignore', log, log], env: { ...process.env, MAGPIE_1P_HOME: home } });
      child.on('error', e => console.error('[Claude 1P] Could not start runtime:', e.message));
      child.unref(); fs.closeSync(log);
      // The next heartbeat claims a lease after the worker has bound its control listener.
    } finally { starting = false; }
  }
  void heartbeat();
  const timer = setInterval(heartbeat, 5000); timer.unref();
  // Do not register signal handlers: those would replace Magpie's host shutdown behavior.
  process.once('exit', () => { closed = true; clearInterval(timer); });
  return {};
}
