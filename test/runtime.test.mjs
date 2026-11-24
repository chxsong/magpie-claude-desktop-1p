import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
const freePort = () => new Promise((resolve, reject) => { const s = net.createServer(); s.once('error', reject); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); }); });
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { DesktopProfile, desktopPaths, PROFILE } from '../src/desktop.mjs';
import { ClaudeSettings } from '../src/settings.mjs';
import { readJson, writeJson } from '../src/files.mjs';
const pause = ms => new Promise(r => setTimeout(r, ms));
async function until(check, ms = 14000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { const result = check(); if (result) return result; await pause(150); }
  throw new Error('Timed out waiting for the isolated plugin runtime');
}
test('Bundled Bun runtime waits for trust and restores existing wiring after disconnect', { timeout: 22000 }, async t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'magpie-1p-runtime-'));
  const dir = path.join(home, '.claude/magpie-1p');
  const config = path.join(home, '.claude/settings.json');
  writeJson(config, { env: { USER_VALUE: 'keep' } });
  writeJson(path.join(dir, 'connection.json'), { gateway: 'http://127.0.0.1:3425', key: 'test-not-real', models: [{ id: 'test/coder', name: 'Coder' }] });
  const desktop = desktopPaths(home);
  writeJson(path.join(desktop.library, '_meta.json'), { appliedId: 'previous-profile', entries: [{ id: 'previous-profile', name: 'User profile' }] });
  const controlPort = await freePort(), proxyPort = await freePort();
  const host = spawn('bun', [fileURLToPath(new URL('./fixtures/host.mjs', import.meta.url))], { env: { ...process.env, HOME: home, MAGPIE_1P_SANDBOX: '1', MAGPIE_1P_HOME: home, MAGPIE_1P_CONTROL_PORT: String(controlPort), MAGPIE_1P_PROXY_PORT: String(proxyPort) }, stdio: ['ignore', 'ignore', 'pipe'] });
  let stderr = ''; host.stderr.on('data', c => stderr += c);
  let worker;
  t.after(async () => {
    host.kill('SIGTERM');
    if (worker) {
      try { process.kill(worker, 'SIGTERM'); } catch {}
      await until(() => readJson(path.join(dir, 'status.json'), {}).phase === 'stopped', 4000).catch(() => {});
    }
    fs.rmSync(home, { recursive: true, force: true });
  });
  const status = await until(() => {
    const status = readJson(path.join(dir, 'status.json'), {});
    if (status.pid) worker = status.pid;
    if (status.phase === 'error') throw new Error(status.error);
    if (host.exitCode !== null) throw new Error(`Host exited: ${stderr}`);
    return status.phase === 'needs-trust' && status;
  });
  assert.equal(status.models, 1);
  const pkg = readJson(new URL('../package.json', import.meta.url));
  assert.equal(status.runtimeVersion, pkg.version);
  assert.deepEqual(status.lastRoute, {});
  assert.equal(readJson(path.join(desktop.library, '_meta.json')).appliedId, 'previous-profile');
  assert.deepEqual(readJson(config), { env: { USER_VALUE: 'keep' } });
  assert.equal(fs.existsSync(path.join(dir, 'trust.json')), false);

  // Seed the managed wiring of a previous trusted run without touching the keychain.
  const proxyURL = 'http://127.0.0.1:' + proxyPort;
  new DesktopProfile(desktop, dir).enable(proxyURL);
  new ClaudeSettings(config, dir).enable(proxyURL, path.join(dir, 'ca.pem'));
  assert.equal(readJson(path.join(desktop.library, '_meta.json')).appliedId, PROFILE);
  assert.equal(readJson(config).env.HTTPS_PROXY, proxyURL);
  fs.rmSync(path.join(dir, 'connection.json'));
  await until(() => readJson(path.join(dir, 'status.json'), {}).phase === 'disconnected');
  assert.deepEqual(readJson(config), { env: { USER_VALUE: 'keep' } });
  assert.equal(readJson(path.join(desktop.library, '_meta.json')).appliedId, 'previous-profile');
});
