import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import forge from 'node-forge';
import { privateDir } from './files.mjs';
const SUBJECT = [{ name: 'commonName', value: 'Magpie Claude 1P Local CA' }];
function keys() {
  const pair = crypto.generateKeyPairSync('rsa', { modulusLength: 2048, publicKeyEncoding: { type: 'spki', format: 'pem' }, privateKeyEncoding: { type: 'pkcs8', format: 'pem' } });
  return { publicKey: forge.pki.publicKeyFromPem(pair.publicKey), privateKey: forge.pki.privateKeyFromPem(pair.privateKey) };
}
function certFor(publicKey, days) {
  const cert = forge.pki.createCertificate();
  cert.publicKey = publicKey;
  cert.serialNumber = '01' + crypto.randomBytes(15).toString('hex');
  cert.validity.notBefore = new Date(Date.now() - 300000);
  cert.validity.notAfter = new Date(Date.now() + days * 86400000);
  return cert;
}
export function ensureCA(dir) {
  privateDir(dir);
  const certPath = path.join(dir, 'ca.pem'), keyPath = path.join(dir, 'ca-key.pem');
  if (fs.existsSync(certPath) !== fs.existsSync(keyPath)) throw new Error('Incomplete local certificate identity; refusing to silently replace a trusted CA.');
  if (!fs.existsSync(certPath)) {
    const pair = keys(), cert = certFor(pair.publicKey, 3650);
    cert.setSubject(SUBJECT); cert.setIssuer(SUBJECT);
    cert.setExtensions([{ name: 'basicConstraints', cA: true, critical: true, pathLenConstraint: 0 }, { name: 'keyUsage', keyCertSign: true, cRLSign: true, critical: true }]);
    cert.sign(pair.privateKey, forge.md.sha256.create());
    fs.writeFileSync(keyPath, forge.pki.privateKeyToPem(pair.privateKey), { mode: 0o600, flag: 'wx' });
    fs.writeFileSync(certPath, forge.pki.certificateToPem(cert), { mode: 0o600, flag: 'wx' });
  }
  const cert = forge.pki.certificateFromPem(fs.readFileSync(certPath, 'utf8'));
  const key = forge.pki.privateKeyFromPem(fs.readFileSync(keyPath, 'utf8'));
  if (cert.validity.notAfter.getTime() <= Date.now() + 86400000) throw new Error('Local CA expired or expiring; disconnect and remove its trust before regenerating.');
  if (cert.publicKey.n.toString(16) !== key.n.toString(16) || cert.publicKey.e.toString(16) !== key.e.toString(16)) throw new Error('Local CA certificate and private key do not match');
  const cache = new Map();
  return { certPath, pem: fs.readFileSync(certPath, 'utf8'), leaf(host) {
    if (!['api.anthropic.com', 'claude.ai'].includes(host)) throw new Error('Host is outside the certificate allowlist');
    if (!cache.has(host)) {
      const pair = keys(), leaf = certFor(pair.publicKey, 30);
      leaf.setSubject([{ name: 'commonName', value: host }]); leaf.setIssuer(cert.subject.attributes);
      leaf.setExtensions([{ name: 'basicConstraints', cA: false, critical: true }, { name: 'keyUsage', digitalSignature: true, keyEncipherment: true, critical: true }, { name: 'extKeyUsage', serverAuth: true }, { name: 'subjectAltName', altNames: [{ type: 2, value: host }] }]);
      leaf.sign(key, forge.md.sha256.create());
      cache.set(host, { key: forge.pki.privateKeyToPem(pair.privateKey), cert: forge.pki.certificateToPem(leaf) });
    }
    return cache.get(host);
  } };
}
