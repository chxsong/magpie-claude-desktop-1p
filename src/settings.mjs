import fs from 'node:fs';
import path from 'node:path';
import { readJson, writeJson } from './files.mjs';
export class ClaudeSettings {
  constructor(file, stateDir) { this.file = file; this.journal = path.join(stateDir, 'settings-journal.json'); }
  enable(proxyURL, caPath) {
    const config = readJson(this.file, {});
    if (!config || typeof config !== 'object' || Array.isArray(config)) throw new Error('Unrecognized Claude settings');
    if (config.env !== undefined && (!config.env || typeof config.env !== 'object' || Array.isArray(config.env))) throw new Error('Unrecognized Claude environment');
    const env = config.env || {};
    let journal = readJson(this.journal, null);
    const writes = { HTTPS_PROXY: proxyURL, NODE_EXTRA_CA_CERTS: caPath };
    if (!journal) {
      for (const key of Object.keys(writes)) {
        if (env[key] !== undefined && env[key] !== writes[key]) throw new Error(`Existing ${key} conflicts with 1P setup; no settings changed.`);
      }
      journal = { hadEnv: config.env !== undefined, before: Object.fromEntries(Object.keys(writes).map(key => [key, { exists: Object.hasOwn(env, key), value: env[key] }])), writes };
      writeJson(this.journal, journal);
    } else {
      for (const [key, value] of Object.entries(journal.writes)) {
        if (env[key] !== value && env[key] !== journal.before[key].value) throw new Error(`${key} changed externally; refusing to replace it.`);
      }
    }
    if (Object.entries(writes).every(([key, value]) => env[key] === value)) return;
    writeJson(this.file, { ...config, env: { ...env, ...writes } });
  }
  disable() {
    const journal = readJson(this.journal, null);
    if (!journal) return;
    const config = readJson(this.file, {}), env = { ...(config.env || {}) };
    let changed = false;
    for (const [key, value] of Object.entries(journal.writes)) {
      if (env[key] !== value) continue; // The user's newer edit wins.
      const before = journal.before[key];
      if (before.exists) env[key] = before.value; else delete env[key];
      changed = true;
    }
    if (changed) {
      const next = { ...config, env };
      if (!journal.hadEnv && Object.keys(env).length === 0) delete next.env;
      writeJson(this.file, next);
    }
    fs.rmSync(this.journal, { force: true });
  }
}
