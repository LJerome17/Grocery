// App icons and the page logo from Logo/Icône d'application@1x.png (1024×1024).
// Usage: npx tsx scripts/build-icons.ts
import sharp from "sharp";
import { join } from "node:path";

const ROOT = join(__dirname, "..");
const SRC = join(ROOT, "Logo", "Icône d'application@1x.png");

async function main() {
  for (const size of [192, 512]) await sharp(SRC).resize(size, size).png().toFile(join(ROOT, "public", `icon-${size}.png`));
  await sharp(SRC).resize(180, 180).png().toFile(join(ROOT, "public", "apple-touch-icon.png"));
  await sharp(SRC).resize(48, 48).png().toFile(join(ROOT, "public", "favicon-48.png"));
  // Page logo: the two aprons, without the empty margin.
  await sharp(SRC).extract({ left: 150, top: 280, width: 724, height: 470 }).resize(360).webp({ quality: 90 }).toFile(join(ROOT, "public", "logo.webp"));
  console.log("icônes et logo -> public/");
}
main();
