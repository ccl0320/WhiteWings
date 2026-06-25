import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, "..");
const dataDir = path.join(rootDir, "data");
const sourcesPath = path.join(dataDir, "price-sources.json");
const brandWatchPath = path.join(dataDir, "brand-watch-sources.json");
const productBaselinePath = path.join(dataDir, "product-list-baseline.json");
const priceOutputPath = path.join(dataDir, "latest-prices.js");
const productOutputPath = path.join(dataDir, "latest-product-list.js");
const priceLogPath = path.join(dataDir, "scan-log.jsonl");
const productLogPath = path.join(dataDir, "product-list-log.jsonl");

const now = new Date().toISOString();

async function readJson(filePath, fallback) {
  try {
    return JSON.parse((await fs.readFile(filePath, "utf8")).replace(/^\uFEFF/, ""));
  } catch (error) {
    if (error && error.code === "ENOENT") return fallback;
    throw error;
  }
}

function normalizeHtml(html) {
  return html
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&#36;/g, "$")
    .replace(/,/g, "")
    .replace(/\s+/g, " ");
}

function safeDecode(text) {
  try {
    return decodeURIComponent(text);
  } catch {
    return text;
  }
}

function parsePrices(html, minPrice = 17000) {
  const normalized = normalizeHtml(html);
  const patterns = [
    /NT\s?\$?\s?([0-9]{4,6})/ig,
    /NTD\s?([0-9]{4,6})/ig,
    /\$\s?([0-9]{4,6})/g,
    /([0-9]{4,6})\s?(?:TWD|NTD)/ig
  ];

  const candidates = [];
  for (const pattern of patterns) {
    for (const match of normalized.matchAll(pattern)) {
      const price = Number(match[1]);
      if (price >= minPrice && price <= 200000) candidates.push(price);
    }
  }
  return [...new Set(candidates)].sort((a, b) => a - b);
}

async function fetchHtml(url) {
  const response = await fetch(url, {
    headers: {
      "user-agent": "Mozilla/5.0 BoschTWPriceMonitor/1.0",
      "accept": "text/html,application/xhtml+xml"
    }
  });
  return {
    ok: response.ok,
    status: response.status,
    html: await response.text()
  };
}

async function scanPriceUrl(source, url) {
  const response = await fetchHtml(url);
  const minPrice = source.minPrice || 17000;
  const prices = parsePrices(response.html, minPrice);
  const lowestPrice = prices.length ? prices[0] : null;
  const highestPrice = prices.length ? prices[prices.length - 1] : null;
  return {
    sku: source.sku,
    url,
    price: lowestPrice,
    minPrice: lowestPrice,
    maxPrice: highestPrice,
    priceCandidates: prices,
    checkedAt: now,
    status: response.ok && lowestPrice ? "Updated" : response.ok ? "Price not found" : "Fetch failed",
    httpStatus: response.status
  };
}

async function scanPrices(sources) {
  const items = [];

  for (const source of sources) {
    const urls = Array.isArray(source.urls) ? source.urls.filter(Boolean) : [];
    if (!source.sku || urls.length === 0) continue;

    const results = [];
    for (const url of urls) {
      try {
        results.push(await scanPriceUrl(source, url));
      } catch (error) {
        results.push({
          sku: source.sku,
          url,
          price: null,
          checkedAt: now,
          status: "Fetch failed",
          error: String(error && error.message || error)
        });
      }
    }

    const priced = results.filter(item => item.price);
    const winner = priced.sort((a, b) => a.price - b.price)[0] || results[0];
    const allPrices = results
      .flatMap(item => Array.isArray(item.priceCandidates) ? item.priceCandidates : item.price ? [item.price] : [])
      .filter(price => Number.isFinite(price))
      .sort((a, b) => a - b);
    const minFoundPrice = allPrices.length ? allPrices[0] : null;
    const maxFoundPrice = allPrices.length ? allPrices[allPrices.length - 1] : null;
    items.push({
      sku: source.sku,
      brand: source.brand || "",
      url: winner.url,
      price: minFoundPrice,
      minPrice: minFoundPrice,
      maxPrice: maxFoundPrice,
      priceRange: minFoundPrice && maxFoundPrice ? { min: minFoundPrice, max: maxFoundPrice } : null,
      checkedAt: now,
      status: winner.status,
      sourceCount: urls.length,
      allResults: results
    });
  }

  return {
    generatedAt: now,
    itemCount: items.length,
    items
  };
}

function compilePatterns(patterns) {
  return (patterns || []).map(pattern => new RegExp(pattern, "gi"));
}

function normalizeSku(sku) {
  return String(sku || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
}

function isNoiseSku(sku) {
  const normalized = normalizeSku(sku);
  return normalized.length < 5 || /STORE|VIP|FREE|SALE|HTML|HTTP/.test(normalized);
}

function isKnownSkuVariant(sku, knownNorms) {
  const normalized = normalizeSku(sku);
  if (knownNorms.has(normalized)) return true;
  for (const known of knownNorms) {
    if (normalized.length >= 6 && (known.startsWith(normalized) || normalized.startsWith(known))) {
      return true;
    }
  }
  return false;
}

function extractSkuCandidates(html, patterns) {
  const text = safeDecode(normalizeHtml(html)).toUpperCase();
  const found = new Set();
  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern)) {
      const sku = String(match[0])
        .replace(/\s+/g, " ")
        .replace(/[，,。:;|()[\]{}<>]/g, "")
        .trim();
      if (sku.length >= 4 && sku.length <= 32) found.add(sku);
    }
  }
  const byNormalized = new Map();
  for (const sku of found) {
    if (isNoiseSku(sku)) continue;
    const key = normalizeSku(sku);
    const current = byNormalized.get(key);
    if (!current || sku.length > current.length) byNormalized.set(key, sku);
  }
  return [...byNormalized.values()].sort();
}

function baselineNormsForBrand(productBaseline) {
  const result = new Map();
  for (const brand of productBaseline.brands || []) {
    result.set(
      brand.brand,
      new Set((brand.skus || []).map(normalizeSku).filter(Boolean))
    );
  }
  return result;
}

async function scanBrandLists(brandWatch, knownSkuSet, knownNorms, productBaseline) {
  const brands = [];
  const allNew = [];
  const allUnmapped = [];
  const baselineByBrand = baselineNormsForBrand(productBaseline);

  for (const source of brandWatch.brands || []) {
    const urls = Array.isArray(source.urls) ? source.urls.filter(Boolean) : [];
    const patterns = compilePatterns(source.patterns);
    const found = new Set();
    const sourceResults = [];

    for (const url of urls) {
      try {
        const response = await fetchHtml(url);
        const candidates = extractSkuCandidates(response.html, patterns);
        candidates.forEach(sku => found.add(sku));
        sourceResults.push({
          url,
          status: response.ok ? "Scanned" : "Fetch failed",
          httpStatus: response.status,
          candidateCount: candidates.length
        });
      } catch (error) {
        sourceResults.push({
          url,
          status: "Fetch failed",
          error: String(error && error.message || error),
          candidateCount: 0
        });
      }
    }

    const foundSkus = [...found].sort();
    const knownSkus = foundSkus.filter(sku => isKnownSkuVariant(sku, knownNorms));
    const unmappedCandidates = foundSkus
      .filter(sku => !isKnownSkuVariant(sku, knownNorms))
      .map(sku => ({
        sku,
        brand: source.brand,
        firstDetectedAt: now,
        status: "Unmapped"
      }));

    const brandBaseline = baselineByBrand.get(source.brand) || new Set();
    const newCandidates = foundSkus
      .filter(sku => !brandBaseline.has(normalizeSku(sku)))
      .filter(sku => !isKnownSkuVariant(sku, knownNorms))
      .map(sku => ({
        sku,
        brand: source.brand,
        firstDetectedAt: now,
        status: "New since baseline"
      }));

    allNew.push(...newCandidates);
    allUnmapped.push(...unmappedCandidates);
    brands.push({
      brand: source.brand,
      sourceCount: urls.length,
      foundCount: foundSkus.length,
      knownCount: knownSkus.length,
      unmappedCandidateCount: unmappedCandidates.length,
      newCandidateCount: newCandidates.length,
      foundSkus,
      knownSkus,
      unmappedCandidates,
      newCandidates,
      sources: sourceResults
    });
  }

  return {
    generatedAt: now,
    knownSkuCount: knownSkuSet.size,
    brandCount: brands.length,
    unmappedCandidateCount: allUnmapped.length,
    newCandidateCount: allNew.length,
    brands,
    unmappedCandidates: allUnmapped,
    newCandidates: allNew
  };
}

const priceConfig = await readJson(sourcesPath, { sources: [] });
const brandWatch = await readJson(brandWatchPath, { brands: [] });
const productBaseline = await readJson(productBaselinePath, { brands: [] });
const priceSources = Array.isArray(priceConfig.sources) ? priceConfig.sources : [];
const knownSkuSet = new Set(priceSources.map(source => String(source.sku || "").toUpperCase()).filter(Boolean));
const knownNorms = new Set([...knownSkuSet].map(normalizeSku).filter(Boolean));

const pricePayload = await scanPrices(priceSources);
const productPayload = await scanBrandLists(brandWatch, knownSkuSet, knownNorms, productBaseline);

await fs.writeFile(priceOutputPath, `window.PRICE_UPDATES = ${JSON.stringify(pricePayload, null, 2)};\n`, "utf8");
await fs.writeFile(productOutputPath, `window.PRODUCT_LIST_UPDATES = ${JSON.stringify(productPayload, null, 2)};\n`, "utf8");
await fs.appendFile(priceLogPath, JSON.stringify(pricePayload) + "\n", "utf8");
await fs.appendFile(productLogPath, JSON.stringify(productPayload) + "\n", "utf8");

console.log(`Updated ${pricePayload.items.length} SKU price records at ${now}`);
console.log(`Detected ${productPayload.newCandidateCount} new product candidates across ${productPayload.brandCount} brands`);
console.log(priceOutputPath);
console.log(productOutputPath);
