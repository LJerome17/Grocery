// Grid of all recipe pictures with their number, to review them at a glance.
// Usage: npx tsx scripts/contact-sheet.ts <out.png> [cols=8]
import { readdirSync } from "node:fs";
import { join } from "node:path";
import sharp from "sharp";

const ROOT = join(__dirname, "..");
const IMAGES = join(ROOT, "data", "images");
const out = process.argv[2] ?? join(ROOT, "contact-sheet.png");
const cols = Number(process.argv[3] ?? 8);
const TW = 180, TH = 130, LABEL = 18;

async function main() {
  const files = readdirSync(IMAGES).filter((f) => f.endsWith(".webp")).sort();
  const rows = Math.ceil(files.length / cols);
  const tiles = await Promise.all(
    files.map(async (f, i) => {
      const img = await sharp(join(IMAGES, f)).resize(TW, TH, { fit: "cover" }).toBuffer();
      const label = Buffer.from(
        `<svg xmlns="http://www.w3.org/2000/svg" width="${TW}" height="${LABEL}"><rect width="100%" height="100%" fill="#000"/><text x="4" y="14" font-size="13" font-family="Arial" fill="#fff">${i + 1}. ${f.slice(0, 22)}</text></svg>`,
      );
      const x = (i % cols) * TW, y = Math.floor(i / cols) * (TH + LABEL);
      return [
        { input: img, left: x, top: y },
        { input: label, left: x, top: y + TH },
      ];
    }),
  );
  await sharp({ create: { width: cols * TW, height: rows * (TH + LABEL), channels: 3, background: "#222" } })
    .composite(tiles.flat())
    .png()
    .toFile(out);
  files.forEach((f, i) => console.log(`${i + 1}. ${f}`));
}

main();
