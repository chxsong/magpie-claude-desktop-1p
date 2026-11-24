import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'magpie-1p-test-home-'));
try {
  const tests = fs.readdirSync('test').filter(n => n.endsWith('.test.mjs')).map(n => 'test/' + n);
  const result = spawnSync(process.execPath, ['--test', ...tests], { stdio: 'inherit', env: { ...process.env, HOME: home, MAGPIE_1P_HOME: home, MAGPIE_1P_SANDBOX: '1' } });
  process.exitCode = result.status ?? 1;
} finally { fs.rmSync(home, { recursive: true, force: true }); }
