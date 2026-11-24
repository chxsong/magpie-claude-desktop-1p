import { mkdir } from 'node:fs/promises';
await mkdir('dist', { recursive: true });
for (const entry of ['index', 'worker']) {
  const r = await Bun.build({ entrypoints: [`src/${entry}.mjs`], outdir: 'dist', naming: `${entry}.mjs`, target: 'bun', minify: false });
  if (!r.success) throw new AggregateError(r.logs, 'Build failed');
}
