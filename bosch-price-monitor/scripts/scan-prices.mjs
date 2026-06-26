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

function priceSearchUrlsForSku(sku, brand = "") {
  const dishwasherKeyword = "\u6d17\u7897\u6a5f";
  const queries = [
    sku,
    brand ? `${brand} ${sku}` : "",
    brand ? `${brand} ${sku} ${dishwasherKeyword}` : ""
  ].filter(Boolean);

  return [...new Set(queries.flatMap(query => {
    const encoded = encodeURIComponent(query);
    return [
      `https://biggo.com.tw/s/${encoded}/`,
      `https://feebee.com.tw/s/${encoded}/`
    ];
  }))];
}

function dynamicPriceSourcesFromProductPayload(productPayload, configuredPriceSources, brandWatch) {
  const configuredNorms = new Set(configuredPriceSources.map(source => normalizeSku(source.sku)).filter(Boolean));
  const enabledBrands = new Set((brandWatch.brands || [])
    .filter(source => source.priceScanDiscovered)
    .map(source => source.brand));

  const sources = [];
  for (const brand of productPayload.brands || []) {
    if (!enabledBrands.has(brand.brand)) continue;
    for (const sku of brand.foundSkus || []) {
      if (configuredNorms.has(normalizeSku(sku))) continue;
      sources.push({
        sku,
        brand: brand.brand,
        minPrice: 17000,
        discoverySource: "product-list-scan",
        urls: priceSearchUrlsForSku(sku, brand.brand)
      });
    }
  }
  return sources;
}

function compilePatterns(patterns) {
  return (patterns || []).map(pattern => new RegExp(pattern, "gi"));
}

function normalizeSku(sku) {
  return String(sku || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
}

function isNoiseSku(sku) {
  const normalized = normalizeSku(sku);
  return normalized.length < 5 || /STORE|VIP|FREE|SALE|HTML|HTTP|PROGRESS/.test(normalized);
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

const featureTagRules = [
  { tag: "Auto Open", patterns: [/AUTO\s?OPEN/i, /自動開門/i, /自動開啟/i, /自動開/i] },
  { tag: "3rd drawer", patterns: [/3RD\s?DRAWER/i, /THIRD\s?DRAWER/i, /第三層/i, /第三層收納/i, /刀叉/i] },
  { tag: "Steam", patterns: [/STEAM/i, /蒸氣/i, /蒸汽/i] },
  { tag: "Wi-Fi", patterns: [/WI-?FI/i, /WIFI/i, /HOME\s?CONNECT/i, /連網/i, /智慧連線/i] },
  { tag: "Zeolith", patterns: [/ZEOLITH/i, /沸石/i] },
  { tag: "Auto Dos", patterns: [/AUTO\s?DOS/i, /自動投放/i] },
  { tag: "UV", patterns: [/\bUV\b/i, /紫外線/i] },
  { tag: "Hot air dry", patterns: [/HOT\s?AIR/i, /熱風/i, /熱烘/i] },
  { tag: "Solo Dry", patterns: [/SOLO\s?DRY/i, /獨立烘/i] },
  { tag: "Pre-rinse", patterns: [/PRE-?RINSE/i, /預洗/i] },
  { tag: "IntensiveZone", patterns: [/INTENSIVE\s?ZONE/i, /強力洗/i] },
  { tag: "Sliding Hinge", patterns: [/SLIDING\s?HINGE/i, /滑軌/i, /滑門/i] },
  { tag: "110V", patterns: [/\b110V\b/i] },
  { tag: "220V", patterns: [/\b220V\b/i] }
];

function featureTagsFromText(text) {
  const normalized = safeDecode(normalizeHtml(text));
  return featureTagRules
    .filter(rule => rule.patterns.some(pattern => pattern.test(normalized)))
    .map(rule => rule.tag);
}

function mergeFeatureTags(current, next) {
  return [...new Set([...(current || []), ...(next || [])])].sort();
}

function extractSkuCandidates(html, patterns) {
  const text = safeDecode(normalizeHtml(html)).toUpperCase();
  const found = new Set();
  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern)) {
      const sku = String(match[0])
        .replace(/\s+/g, " ")
        .replace(/[，,。:;|()[\]{}<>]/g, "")
        .trim()
        .replace(/^[\s-]+|[\s-]+$/g, "");
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

function extractSkuFeatureTags(html, skus) {
  const text = safeDecode(normalizeHtml(html));
  const upper = text.toUpperCase();
  const featuresBySku = new Map();
  for (const sku of skus) {
    const normalized = normalizeSku(sku);
    const compactUpper = upper.replace(/[^A-Z0-9]/g, "");
    let index = upper.indexOf(String(sku).toUpperCase());
    if (index < 0) index = compactUpper.indexOf(normalized);
    if (index < 0) continue;
    const start = Math.max(0, index - 800);
    const end = Math.min(text.length, index + 1200);
    const tags = featureTagsFromText(text.slice(start, end));
    if (tags.length) featuresBySku.set(sku, tags);
  }
  return featuresBySku;
}

function featureObjectList(featureTagsBySku) {
  return [...featureTagsBySku.entries()]
    .sort((a, b) => String(a[0]).localeCompare(String(b[0])))
    .map(([sku, tags]) => ({ sku, tags }));
}

function displaySkuScore(sku) {
  const text = String(sku || "");
  let score = 0;
  if (!/[^\w\s.-]/.test(text)) score += 4;
  if (!/[-\s.]$/.test(text)) score += 3;
  if (/[-\s.]/.test(text)) score += 1;
  return score + Math.min(text.length, 32) / 100;
}

function dedupeSkus(skus, featureTagsBySku) {
  const byNormalized = new Map();
  for (const sku of skus) {
    const key = normalizeSku(sku);
    if (!key) continue;
    const current = byNormalized.get(key);
    if (!current || displaySkuScore(sku) > displaySkuScore(current)) {
      byNormalized.set(key, sku);
    }
  }

  const canonicalByNorm = new Map([...byNormalized.entries()].map(([key, sku]) => [key, sku]));
  const mergedTags = new Map();
  for (const sku of skus) {
    const canonical = canonicalByNorm.get(normalizeSku(sku));
    if (!canonical) continue;
    mergedTags.set(canonical, mergeFeatureTags(mergedTags.get(canonical), featureTagsBySku.get(sku) || []));
  }
  featureTagsBySku.clear();
  for (const [sku, tags] of mergedTags.entries()) {
    if (tags.length) featureTagsBySku.set(sku, tags);
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
    const featureTagsBySku = new Map();
    const sourceResults = [];

    for (const url of urls) {
      try {
        const response = await fetchHtml(url);
        const candidates = extractSkuCandidates(response.html, patterns);
        candidates.forEach(sku => found.add(sku));
        const extractedFeatures = extractSkuFeatureTags(response.html, candidates);
        for (const [sku, tags] of extractedFeatures.entries()) {
          featureTagsBySku.set(sku, mergeFeatureTags(featureTagsBySku.get(sku), tags));
        }
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

    const foundSkus = dedupeSkus([...found], featureTagsBySku);
    const knownSkus = foundSkus.filter(sku => isKnownSkuVariant(sku, knownNorms));
    const unmappedCandidates = foundSkus
      .filter(sku => !isKnownSkuVariant(sku, knownNorms))
      .map(sku => ({
        sku,
        brand: source.brand,
        featureTags: featureTagsBySku.get(sku) || [],
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
        featureTags: featureTagsBySku.get(sku) || [],
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
      featureTagsBySku: featureObjectList(featureTagsBySku),
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

const productPayload = await scanBrandLists(brandWatch, knownSkuSet, knownNorms, productBaseline);
const dynamicPriceSources = dynamicPriceSourcesFromProductPayload(productPayload, priceSources, brandWatch);
const pricePayload = await scanPrices([...priceSources, ...dynamicPriceSources]);

await fs.writeFile(priceOutputPath, `window.PRICE_UPDATES = ${JSON.stringify(pricePayload, null, 2)};\n`, "utf8");
await fs.writeFile(productOutputPath, `window.PRODUCT_LIST_UPDATES = ${JSON.stringify(productPayload, null, 2)};\n`, "utf8");
await fs.appendFile(priceLogPath, JSON.stringify(pricePayload) + "\n", "utf8");
await fs.appendFile(productLogPath, JSON.stringify(productPayload) + "\n", "utf8");

console.log(`Updated ${pricePayload.items.length} SKU price records at ${now}`);
console.log(`Detected ${productPayload.newCandidateCount} new product candidates across ${productPayload.brandCount} brands`);
console.log(priceOutputPath);
console.log(productOutputPath);
