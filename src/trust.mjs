import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { X509Certificate } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
const exec = promisify(execFile);
export async function isTrusted(caPath) {
  if (process.env.MAGPIE_1P_SANDBOX === '1' || process.platform !== 'darwin') return false;
  try { await exec('/usr/bin/security', ['verify-cert', '-q', '-L', '-l', '-p', 'basic', '-c', caPath], { timeout: 15000 }); return true; } catch { return false; }
}
export async function trustCA(caPath, home, platform = process.platform) {
  if (process.env.MAGPIE_1P_SANDBOX === '1') throw new Error('System trust is disabled in sandbox tests.');
  if (platform !== 'darwin') throw new Error('This alpha supports macOS only; Windows/Linux have not been qualified.');
  await exec('/usr/bin/security', ['add-trusted-cert', '-r', 'trustRoot', '-k', path.join(home, 'Library/Keychains/login.keychain-db'), caPath], { timeout: 120000, maxBuffer: 1024 * 1024 });
  if (!await isTrusted(caPath)) throw new Error('The OS did not confirm trust for the local CA');
}
export async function removeCA(caPath, home) {
  if (process.env.MAGPIE_1P_SANDBOX === '1') throw new Error('System trust is disabled in sandbox tests.');
  if (process.platform !== 'darwin' || !fs.existsSync(caPath)) return;
  const cert = new X509Certificate(fs.readFileSync(caPath));
  // Exact certificate fingerprint; never delete another application's certificate by name.
  await exec('/usr/bin/security', ['delete-certificate', '-Z', cert.fingerprint.replaceAll(':', ''), path.join(home, 'Library/Keychains/login.keychain-db')], { timeout: 15000 });
}

export async function clearTrust(directory, home, remove = removeCA) {
  const journal = path.join(directory, 'trust.json');
  if (!fs.existsSync(journal)) return;
  const caPath = path.join(directory, 'ca.pem');
  const cert = new X509Certificate(fs.readFileSync(caPath));
  const saved = JSON.parse(fs.readFileSync(journal, 'utf8'));
  if (saved.fingerprint !== cert.fingerprint256) throw new Error('Local CA fingerprint differs from trust journal; removal refused.');
  await remove(caPath, home);
  fs.rmSync(journal);
}
