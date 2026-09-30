// App icons and the page logo from the round logo in Logo/ (1024×1024, transparent outside the circle).
// Usage: npx tsx scripts/build-icons.ts
import sharp from "sharp";
import { readdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(__dirname, "..");
// The most recent picture in Logo/ (the file name changes with each new version).
const LOGO_DIR = join(ROOT, "Logo");
const SRC = join(
  LOGO_DIR,
  readdirSync(LOGO_DIR)
    .filter((f) => /.(png|jpe?g|webp)$/i.test(f))
    .sort((a, b) => statSync(join(LOGO_DIR, b)).mtimeMs - statSync(join(LOGO_DIR, a)).mtimeMs)[0],
);
const BG = "#f5eee0"; // app background: phones fill transparent corners with black otherwise

/** Square icon: the circle at `scale` of the side, centred on the app background. */
async function icon(size: number, scale: number, file: string) {
  const inner = Math.round(size * scale);
  const logo = await sharp(SRC).resize(inner, inner).toBuffer();
  await sharp({ create: { width: size, height: size, channels: 4, background: BG } })
    .composite([{ input: logo, gravity: "center" }])
    .png()
    .toFile(join(ROOT, "public", file));
}

async function main() {
  await icon(192, 0.92, "icon-192.png");
  await icon(512, 0.92, "icon-512.png");
  await icon(512, 0.78, "icon-maskable-512.png"); // Android crops to a circle or rounded square: keep a margin
  await icon(180, 0.92, "apple-touch-icon.png");
  await sharp(SRC).resize(48, 48).png().toFile(join(ROOT, "public", "favicon-48.png"));
  // favicon.ico (16, 32, 48 px): what browsers and Google ask for first. ICO entries may be PNG images.
  const pngs = await Promise.all([16, 32, 48].map((n) => sharp(SRC).resize(n, n).png().toBuffer()));
  const head = Buffer.alloc(6 + 16 * pngs.length);
  head.writeUInt16LE(0, 0);
  head.writeUInt16LE(1, 2);
  head.writeUInt16LE(pngs.length, 4);
  let offset = head.length;
  pngs.forEach((png, i) => {
    const n = [16, 32, 48][i];
    const e = 6 + 16 * i;
    head.writeUInt8(n, e);
    head.writeUInt8(n, e + 1);
    head.writeUInt16LE(1, e + 4);
    head.writeUInt16LE(32, e + 6);
    head.writeUInt32LE(png.length, e + 8);
    head.writeUInt32LE(offset, e + 12);
    offset += png.length;
  });
  writeFileSync(join(ROOT, "public", "favicon.ico"), Buffer.concat([head, ...pngs]));
  await sharp(SRC).resize(320, 320).webp({ quality: 90 }).toFile(join(ROOT, "public", "logo.webp"));
  console.log("icônes et logo -> public/");
}
main();
