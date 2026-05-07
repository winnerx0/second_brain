import sharp from 'sharp';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const PUBLIC_DIR = join(import.meta.dir, '..', 'public');
const SOURCE_SVG = join(PUBLIC_DIR, 'icon.svg');

const TARGETS = [
  { size: 192, name: 'icon-192.png' },
  { size: 512, name: 'icon-512.png' },
  { size: 180, name: 'apple-touch-icon.png' },
];

const MASKABLE_PADDING = 0.1;

async function main() {
  const svg = await readFile(SOURCE_SVG);

  for (const { size, name } of TARGETS) {
    const out = await sharp(svg, { density: 384 })
      .resize(size, size)
      .png()
      .toBuffer();
    await writeFile(join(PUBLIC_DIR, name), out);
    console.log(`wrote ${name} (${size}x${size})`);
  }

  const maskableSize = 512;
  const inner = Math.round(maskableSize * (1 - MASKABLE_PADDING * 2));
  const innerBuf = await sharp(svg, { density: 384 })
    .resize(inner, inner)
    .png()
    .toBuffer();
  const maskable = await sharp({
    create: {
      width: maskableSize,
      height: maskableSize,
      channels: 4,
      background: '#09090b',
    },
  })
    .composite([{ input: innerBuf, gravity: 'center' }])
    .png()
    .toBuffer();
  await writeFile(join(PUBLIC_DIR, 'icon-maskable-512.png'), maskable);
  console.log('wrote icon-maskable-512.png (512x512)');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
