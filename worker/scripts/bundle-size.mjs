// Reporta el tamaño gzip del bundle (wrangler usa esbuild por debajo).
// Tope interno: 2MB (límite free: 3MB gzip).
import { readFileSync } from "node:fs";
import { gzipSync } from "node:zlib";

const LIMIT = 2 * 1024 * 1024;
const raw = readFileSync(new URL("../dist/bundle.js", import.meta.url));
const gz = gzipSync(raw);
console.log(`bundle: ${raw.length} B raw, ${gz.length} B gzip (tope ${LIMIT} B)`);
if (gz.length > LIMIT) {
  console.error("bundle excede el tope interno");
  process.exit(1);
}
