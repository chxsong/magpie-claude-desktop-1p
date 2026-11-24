import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { X509Certificate } from 'node:crypto';
import { connect } from '../agent.js';
import { ensureCA } from '../src/certificates.mjs';
import { injectModels, modelList, targetModel } from '../src/models.mjs';
import { DesktopProfile, PROFILE, assertFirstParty } from '../src/desktop.mjs';
import { ClaudeSettings } from '../src/settings.mjs';
import { readJson, writeJson } from '../src/files.mjs';
const models = [{ id: 'test/coder', name: 'Coder', context: 128000, efforts: ['low', 'high'] }];
function temp(t) { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'magpie-1p-test-')); t.after(() => fs.rmSync(d, { recursive: true, force: true })); return d; }

test('Agent writes only a sidecar; gateway credentials never enter Claude tool environments', () => {
  const out = connect({ gateway: { url: 'http://127.0.0.1:3425', key: 'own-key' }, models, agent: { config: '/Users/example/.claude/settings.json' } });
  assert.equal(out.key, 'own-key');
  assert.deepEqual(out.models, models);
  assert.equal(Object.keys(out).some(k => k.startsWith('env.')), false);
  assert.equal(out['env.ANTHROPIC_BASE_URL'], undefined);
  assert.equal(out.deploymentMode, undefined);
  assert.throws(() => connect({ gateway: { url: 'http://evil.example' }, models, agent: { config: '/a/b.json' } }), /local/);
});
test('Catalog injection preserves native chat, excludes unknown surfaces and is idempotent', () => {
  const native = { id: 'claude-test', name: 'Claude', context_window: 999999, thinking: { effort_options: [{ value: 'low' }, { value: 'max' }] }, section: 'main', notice: 'marketing', badge: 'paid', is_default: true };
  const json = { model_selector_config: ['chat', 'code', 'future'].map(id => ({ id, models: [structuredClone(native)] })) };
  assert.equal(injectModels(json, models), 1);
  assert.deepEqual(json.model_selector_config[0].models, [native]);
  assert.equal(json.model_selector_config[2].models.length, 1);
  const added = json.model_selector_config[1].models[1];
  assert.equal(added.id, 'magpie/test/coder'); assert.equal(added.context_window, 128000);
  assert.equal(added.minimum_tier, undefined); assert.equal(added.is_default, undefined);
  assert.deepEqual(added.thinking.effort_options, [{ value: 'low' }]);
  assert.equal(injectModels(json, models), 0);
  assert.equal(targetModel('magpie/test/coder@high', models), 'test/coder');
  assert.equal(targetModel('magpie/unknown', models), undefined);
  assert.equal(modelList({ MAGPIE_1P_MODELS: JSON.stringify([...models, ...models]) }).length, 1);
});
test('Profile journal restores selection while preserving unrelated edits', t => {
  const dir = temp(t), library = path.join(dir, 'lib'), state = path.join(dir, 'state');
  writeJson(path.join(library, '_meta.json'), { appliedId: 'previous', entries: [{ id: 'previous', name: 'My profile' }], other: true });
  const p = new DesktopProfile({ library }, state);
  p.enable('http://127.0.0.1:3435'); p.enable('http://127.0.0.1:3435');
  const meta = readJson(path.join(library, '_meta.json'));
  assert.equal(meta.appliedId, PROFILE);
  writeJson(path.join(library, '_meta.json'), { ...meta, newer: 7 });
  p.disable();
  assert.deepEqual(readJson(path.join(library, '_meta.json')), { appliedId: 'previous', entries: [{ id: 'previous', name: 'My profile' }], other: true, newer: 7 });
  assert.equal(fs.existsSync(path.join(library, PROFILE + '.json')), false);
});
test('Uninstall never overrides an externally selected profile', t => {
  const dir = temp(t), library = path.join(dir, 'lib');
  const p = new DesktopProfile({ library }, path.join(dir, 'state'));
  p.enable('http://127.0.0.1:3435');
  const file = path.join(library, '_meta.json'), meta = readJson(file);
  writeJson(file, { ...meta, appliedId: 'another' });
  p.disable(); assert.equal(readJson(file).appliedId, 'another');
});
test('Refuse malformed profiles, foreign ownership and 3P mode', t => {
  const dir = temp(t), library = path.join(dir, 'lib'), state = path.join(dir, 'state');
  writeJson(path.join(library, '_meta.json'), { appliedId: PROFILE });
  assert.throws(() => new DesktopProfile({ library }, state).enable('http://127.0.0.1:3435'), /ownership/);
  const mode = path.join(dir, 'mode.json'); writeJson(mode, { deploymentMode: '3p' });
  assert.throws(() => assertFirstParty({ modes: [mode] }, {}), /3P/);
  assert.throws(() => assertFirstParty({ modes: [] }, { ANTHROPIC_BASE_URL: 'http://127.0.0.1:3425' }), /base URL/);
});
test('Generated leaf is signed by our persistent CA and restricted to two hosts', t => {
  const dir = temp(t), ca = ensureCA(dir);
  const root = new X509Certificate(ca.pem), leaf = new X509Certificate(ca.leaf('api.anthropic.com').cert);
  assert.equal(root.ca, true); assert.equal(leaf.ca, false);
  assert.equal(leaf.verify(root.publicKey), true);
  assert.equal(leaf.checkHost('api.anthropic.com'), 'api.anthropic.com');
  assert.equal(leaf.checkHost('other.example'), undefined);
  assert.equal(ensureCA(dir).pem, ca.pem);
  assert.throws(() => ca.leaf('other.example'), /allowlist/);
  assert.equal(fs.statSync(path.join(dir, 'ca-key.pem')).mode & 0o777, 0o600);
});

test('Settings are restored key by key and preserve concurrent user edits', t => {
  const dir = temp(t), file = path.join(dir, 'settings.json');
  writeJson(file, { permissions: { allow: ['Read'] }, env: { USER_VALUE: 'keep' } });
  const patch = new ClaudeSettings(file, dir);
  patch.enable('http://127.0.0.1:3435', '/private/ca.pem');
  const active = readJson(file);
  assert.equal(active.env.HTTPS_PROXY, 'http://127.0.0.1:3435');
  writeJson(file, { ...active, newer: true, env: { ...active.env, USER_VALUE: 'edited' } });
  patch.disable();
  assert.deepEqual(readJson(file), { permissions: { allow: ['Read'] }, newer: true, env: { USER_VALUE: 'edited' } });
});
test('Foreign proxy/CA settings are refused and newer proxy edits win on removal', t => {
  const dir = temp(t), file = path.join(dir, 'settings.json');
  writeJson(file, { env: { NODE_EXTRA_CA_CERTS: '/enterprise.pem' } });
  const patch = new ClaudeSettings(file, dir);
  assert.throws(() => patch.enable('http://127.0.0.1:3435', '/ca.pem'), /conflicts/);
  writeJson(file, {}); patch.enable('http://127.0.0.1:3435', '/ca.pem');
  const config = readJson(file); config.env.HTTPS_PROXY = 'http://user-proxy'; writeJson(file, config);
  patch.disable(); assert.equal(readJson(file).env.HTTPS_PROXY, 'http://user-proxy');
  assert.equal(readJson(file).env.NODE_EXTRA_CA_CERTS, undefined);
});
