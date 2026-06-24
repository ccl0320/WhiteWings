import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, "..");
const latestPath = path.join(rootDir, "data", "latest-product-list.js");
const baselinePath = path.join(rootDir, "data", "product-list-baseline.json");

const latestText = await fs.readFile(latestPath, "utf8");
const jsonText = latestText
  .replace(/^window\.PRODUCT_LIST_UPDATES\s*=\s*/, "")
  .replace(/;\s*$/, "");
const latest = JSON.parse(jsonText);

const baseline = {
  createdAt: new Date().toISOString(),
  sourceScanAt: latest.generatedAt,
  notes: [
    "Baseline product list for detecting future new competitor models.",
    "The daily scanner flags models not present in this baseline as New since baseline."
  ],
  brands: (latest.brands || []).map(brand => ({
    brand: brand.brand,
    skus: brand.foundSkus || []
  }))
};

await fs.writeFile(baselinePath, JSON.stringify(baseline, null, 2) + "\n", "utf8");
console.log(`Created baseline from ${latest.generatedAt}`);
console.log(baselinePath);
