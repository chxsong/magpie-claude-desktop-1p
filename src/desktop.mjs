import fs from 'node:fs';
import path from 'node:path';
import { readJson, writeJson, privateDir } from './files.mjs';
export const PROFILE = '28ce49f1-bc53-4382-9b6d-1636457b431b';
export function desktopPaths(home) {
  const support = path.join(home, 'Library/Application Support');
  return { library: path.join(support, 'Claude-3p/configLibrary'), modes: [path.join(support, 'Claude/claude_desktop_config.json'), path.join(support, 'Claude-3p/claude_desktop_config.json')] };
}
export function assertFirstParty(paths, env) {
  for (const file of paths.modes) {
    if (readJson(file, {}).deploymentMode === '3p') throw new Error('Claude Desktop is in 3P mode. Disconnect its ordinary Magpie integration and return to native Claude first.');
  }
  if (env.ANTHROPIC_BASE_URL && !/^https:\/\/api\.anthropic\.com\/?$/.test(env.ANTHROPIC_BASE_URL)) throw new Error('Another Claude Code base URL is active. Disconnect the ordinary Claude Code integration before enabling 1P.');
}
export class DesktopProfile {
  constructor(paths, stateDir) { this.paths = paths; this.journal = path.join(stateDir, 'desktop-journal.json'); }
  enable(proxyURL) {
    const lib = this.paths.library, metaFile = path.join(lib, '_meta.json');
    const meta = readJson(metaFile, {});
    if (meta.entries !== undefined && !Array.isArray(meta.entries)) throw new Error('Unrecognized Claude Desktop metadata; no changes made.');
    let saved = readJson(this.journal, null);
    if (!saved) {
      if (meta.appliedId === PROFILE || (meta.entries || []).some(e => e.id === PROFILE)) throw new Error('Profile exists without an ownership journal; refusing to replace it.');
      saved = { previous: meta.appliedId ?? null, proxyURL, createdAt: new Date().toISOString() };
      writeJson(this.journal, saved); // Journal before touching Desktop.
    }
    if (meta.appliedId === PROFILE) {
      const profile = readJson(path.join(lib, PROFILE + '.json'));
      if (profile.egressProxyUrl !== proxyURL) throw new Error('The 1P proxy profile was changed externally; no changes made.');
      return;
    }
    if ((meta.appliedId ?? null) !== saved.previous) throw new Error('Desktop profile selection changed externally; refusing to take it over.');
    privateDir(lib);
    writeJson(path.join(lib, PROFILE + '.json'), { egressProxyUrl: proxyURL });
    writeJson(metaFile, { ...meta, appliedId: PROFILE, entries: [...(meta.entries || []).filter(e => e.id !== PROFILE), { id: PROFILE, name: 'Magpie Claude 1P' }] });
  }
  disable() {
    const saved = readJson(this.journal, null);
    if (!saved) return;
    const lib = this.paths.library, file = path.join(lib, PROFILE + '.json'), metaFile = path.join(lib, '_meta.json');
    const own = readJson(file, null);
    if (own && (own.egressProxyUrl !== saved.proxyURL || Object.keys(own).some(k => k !== 'egressProxyUrl'))) throw new Error('The 1P profile was modified externally; automatic removal refused.');
    const meta = readJson(metaFile, {});
    if (meta.appliedId === PROFILE || (meta.entries || []).some(e => e.id === PROFILE)) {
      const next = { ...meta, entries: (meta.entries || []).filter(e => e.id !== PROFILE) };
      if (meta.appliedId === PROFILE) next.appliedId = saved.previous;
      writeJson(metaFile, next);
    }
    fs.rmSync(file, { force: true });
    fs.rmSync(this.journal, { force: true });
  }
}
