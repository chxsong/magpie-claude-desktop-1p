import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
export function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (e) { if (e.code === 'ENOENT' && arguments.length > 1) return fallback; if (e instanceof SyntaxError) throw new Error(path.basename(file) + ' contains invalid JSON; contents omitted'); throw e; }
}
export function privateDir(dir) { fs.mkdirSync(dir, { recursive: true, mode: 0o700 }); }
export function writeJson(file, value) {
  privateDir(path.dirname(file));
  const temp = `${file}.${crypto.randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temp, JSON.stringify(value, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    fs.renameSync(temp, file);
  } finally { fs.rmSync(temp, { force: true }); }
}
export function credential(file) {
  try { return fs.readFileSync(file, 'utf8').trim(); }
  catch (e) {
    if (e.code !== 'ENOENT') throw e;
    privateDir(path.dirname(file));
    const key = crypto.randomBytes(32).toString('hex');
    try { fs.writeFileSync(file, key, { flag: 'wx', mode: 0o600 }); return key; }
    catch (e) { if (e.code !== 'EEXIST') throw e; return fs.readFileSync(file, 'utf8').trim(); }
  }
}
