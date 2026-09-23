// Builds the Chrome extension (dist/extension) and the debug UI (dist/ui) with esbuild.
import { build } from 'esbuild';
import { copyFileSync, mkdirSync, existsSync, writeFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const ext = join(root, 'dist', 'extension');
const ui = join(root, 'dist', 'ui');
mkdirSync(ext, { recursive: true });
mkdirSync(ui, { recursive: true });

await build({
  entryPoints: { worker: join(root, 'extension/src/worker.ts'), sidepanel: join(root, 'extension/src/sidepanel.ts') },
  outdir: ext, bundle: true, format: 'esm', target: 'chrome125', sourcemap: true, logLevel: 'warning',
});
for (const f of ['manifest.json', 'sidepanel.html', 'sidepanel.css']) copyFileSync(join(root, 'extension', f), join(ext, f));
writeFileSync(join(ext, 'icon128.png'), icon(128));

if (existsSync(join(root, 'ui/src/main.tsx'))) {
  await build({
    entryPoints: [join(root, 'ui/src/main.tsx')], outfile: join(ui, 'app.js'), bundle: true, format: 'esm', target: 'es2022',
    jsx: 'automatic', jsxImportSource: 'preact', sourcemap: true, minify: true, logLevel: 'warning',
  });
  copyFileSync(join(root, 'ui/index.html'), join(ui, 'index.html'));
  copyFileSync(join(root, 'ui/src/styles.css'), join(ui, 'styles.css'));
  writeFileSync(join(ui, 'favicon.png'), icon(64));
}
console.log(`built ${ext}${existsSync(join(ui, 'app.js')) ? ` and ${ui}` : ''}`);

/** A small PNG icon: blue rounded square with a white "J". */
function icon(size) {
  const px = Buffer.alloc(size * size * 4);
  const r = size * 0.22;
  const inRounded = (x, y) => {
    const cx = Math.min(Math.max(x, r), size - 1 - r);
    const cy = Math.min(Math.max(y, r), size - 1 - r);
    return (x - cx) ** 2 + (y - cy) ** 2 <= r * r;
  };
  const s = size / 128;
  const inJ = (x, y) => {
    const X = x / s, Y = y / s;
    const bar = X >= 70 && X <= 86 && Y >= 28 && Y <= 80;
    const top = X >= 50 && X <= 96 && Y >= 28 && Y <= 42;
    const d = Math.hypot(X - 58, Y - 80);
    const hook = Y >= 80 && d >= 12 && d <= 28 && X <= 86;
    return bar || top || hook;
  };
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const i = (y * size + x) * 4;
    if (!inRounded(x, y)) continue;
    const white = inJ(x, y);
    px[i] = white ? 255 : 10; px[i + 1] = white ? 255 : 132; px[i + 2] = 255; px[i + 3] = 255;
  }
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) { raw[y * (size * 4 + 1)] = 0; px.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4); }
  const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
  const crc = (buf) => { let c = 0xffffffff; for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type), data]);
    const c = Buffer.alloc(4); c.writeUInt32BE(crc(td));
    return Buffer.concat([len, td, c]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4); ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}
