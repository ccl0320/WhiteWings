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

function parseMoneyValue(text) {
  const value = String(text || "").replace(/[^0-9]/g, "");
  return value ? Number(value) : null;
}

function officialReferenceUrlForSource(source) {
  if (source.brand !== "Bosch") return "";
  const sku = normalizeSku(source.sku).toLowerCase();
  if (!sku) return "";
  return `https://www.bosch-home-shop.com.tw/products/${sku}`;
}

function parseOfficialReferencePrice(html, url) {
  const compareMatch = html.match(/default-compare-price=["']([^"']+)["']/i);
  const priceMatch = html.match(/default-price=["']([^"']+)["']/i);
  const rsp = parseMoneyValue(compareMatch?.[1]);
  const officialSalePrice = parseMoneyValue(priceMatch?.[1]);
  if (!rsp && !officialSalePrice) return null;
  return {
    rsp,
    officialSalePrice,
    currency: "TWD",
    source: "bosch-home-shop",
    sourceUrl: url,
    evidence: {
      field: rsp ? "default-compare-price" : "default-price",
      rawText: rsp ? compareMatch[1] : priceMatch[1]
    },
    checkedAt: now,
    confidence: rsp ? "high" : "medium"
  };
}

function absoluteUrl(url, base) {
  try {
    return new URL(url, base).toString();
  } catch {
    return url;
  }
}

function displaySkuFromMieleSlug(slug) {
  return String(slug || "")
    .replace(/_/g, " ")
    .toUpperCase()
    .trim();
}

function installTypeFromText(text) {
  if (/全嵌式|FULLY/i.test(text)) return "Fully-integrated";
  if (/半嵌式|SEMI/i.test(text)) return "Semi-integrated";
  if (/獨立式|FREESTANDING/i.test(text)) return "Freestanding";
  return null;
}

function widthFromDimensions(text) {
  const match = String(text || "").match(/W\s*([0-9]{3})/i);
  if (!match) return null;
  const widthMm = Number(match[1]);
  if (widthMm >= 430 && widthMm <= 470) return "45cm";
  if (widthMm >= 570 && widthMm <= 620) return "60cm";
  return null;
}

function parseMieleOfficialMetadata(html, sourceUrl) {
  const cards = String(html || "").split(/<div[^>]+class=["'][^"']*vt-filter[^"']*an-box[^"']*["'][^>]*>/i).slice(1);
  const items = [];
  for (const card of cards) {
    const end = card.indexOf("</div>");
    const segment = end > 0 ? card.slice(0, Math.min(card.length, end + 3000)) : card.slice(0, 3500);
    if (!/dish-washer\/no\./i.test(segment)) continue;
    const href = segment.match(/href=["']([^"']*\/product\/dish-washer\/no\.[^"']+)["']/i)?.[1];
    const slug = href?.match(/\/no\.([^/?#]+)/i)?.[1];
    if (!slug) continue;
    const title = segment.match(/<h2[^>]*>\s*<a[^>]*>([^<]+)/i)?.[1] || "";
    const plain = normalizeHtml(segment.replace(/<[^>]+>/g, " "));
    const dimensionText = plain.match(/W\s*[0-9]{3}\s*\*?\s*D\s*[0-9]{3}\s*\*?\s*H\s*[0-9]{3}\s*mm?/i)?.[0] || "";
    const priceText = plain.match(/\$\s*[0-9,]{4,}/)?.[0] || "";
    const rsp = parseMoneyValue(priceText);
    const type = installTypeFromText(`${title} ${plain}`);
    const width = widthFromDimensions(dimensionText);
    items.push({
      sku: displaySkuFromMieleSlug(slug),
      brand: "Miele",
      width,
      type,
      rsp,
      officialProductUrl: absoluteUrl(href, sourceUrl),
      bodySize: dimensionText || null,
      source: "miele.kenk.com.tw",
      sourceUrl,
      confidence: "high"
    });
  }
  return items;
}

function widthFromDimensionMap(description = {}) {
  const text = Object.entries(description || {})
    .map(([key, value]) => `${key} ${value}`)
    .join(" ");
  const match = text.match(/W\s*([0-9]{2,4})/i) || text.match(/寬\s*([0-9]{2,4})/);
  if (!match) return null;
  const widthMm = Number(match[1]);
  if (widthMm >= 430 && widthMm <= 470) return "45cm";
  if (widthMm >= 570 && widthMm <= 620) return "60cm";
  return null;
}

function typeFromSvagoName(name, sku) {
  const text = `${name || ""} ${sku || ""}`;
  if (/VD6111/i.test(text)) return "Semi-integrated";
  if (/VD|半嵌/i.test(text)) return "Semi-integrated";
  if (/VE8565|VD8565|全嵌|嵌入/i.test(text)) return "Fully-integrated";
  if (/VE|獨立/i.test(text)) return "Freestanding";
  return null;
}

async function parseSvagoOfficialMetadata(categoryJson, sourceUrl) {
  const products = categoryJson?.data?.Products || categoryJson?.Products || categoryJson?.data || [];
  const items = [];
  for (const product of Array.isArray(products) ? products : []) {
    const id = product.Id || product.id || product.ProductId || product.product_id;
    const sku = product.model || product.Model || product.MODEL;
    if (!id || !sku) continue;
    const detailUrl = `https://www.svago-kitchens.com.tw/Product/detail?product_id=${id}`;
    let detail = null;
    try {
      const response = await fetchJson(detailUrl);
      const data = response.json?.data || response.json?.Data || response.json;
      detail = Array.isArray(data) ? data[0] : data;
    } catch {
      detail = null;
    }
    const model = detail?.Model || sku;
    const description = detail?.Description || {};
    const featureList = Array.isArray(detail?.Feature)
      ? detail.Feature.map(item => item.name || item.Name).filter(Boolean)
      : [];
    const width = widthFromDimensionMap(description);
    const rsp = parseMoneyValue(detail?.Price || product.Price || product.price);
    items.push({
      sku: model,
      brand: "Svago",
      width,
      type: typeFromSvagoName(detail?.Name || product.Name || product.name, model),
      rsp,
      officialProductUrl: `https://www.svago-kitchens.com.tw/Product/View/${id}`,
      features: featureList,
      source: "svago-kitchens.com.tw",
      sourceUrl,
      detailUrl,
      confidence: "high"
    });
  }
  return items;
}

function textListFromHtmlBreaks(text) {
  return String(text || "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .split(/\n+/)
    .map(item => normalizeHtml(item).replace(/^●\s*/, "").trim())
    .filter(Boolean);
}

function parsePanasonicOfficialMetadata(json, sourceUrl) {
  const products = json?.products || json?.Products || [];
  const items = [];
  for (const product of Array.isArray(products) ? products : []) {
    const sku = product.modelnumber?.dataAttribute || "";
    if (!sku) continue;
    const description = product.productdescription?.value || "";
    const features = textListFromHtmlBreaks(description);
    const pagePath = product.pagePath || "";
    const productUrl = absoluteUrl(pagePath, "https://www.panasonic.com");
    const title = product.modelnumber?.value || "";
    const type = /嵌入/.test(title) ? "Built-in" : /洗碗乾燥機|桌上|檯面/.test(title) ? "Countertop/compact" : metadataFromSkuRule("Panasonic", sku).type;
    items.push({
      sku,
      brand: "Panasonic",
      width: null,
      type,
      rsp: null,
      officialProductUrl: productUrl,
      features,
      source: "panasonic.com",
      sourceUrl,
      confidence: "high"
    });
    for (const variant of product.variationcolors?.variationicons || []) {
      const variantSku = variant.unifiedModelNumber;
      if (!variantSku) continue;
      items.push({
        sku: variantSku,
        brand: "Panasonic",
        width: null,
        type,
        rsp: null,
        officialProductUrl: productUrl,
        features,
        source: "panasonic.com",
        sourceUrl,
        confidence: "high"
      });
    }
  }
  return items;
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

async function fetchJson(url) {
  const response = await fetch(url, {
    headers: {
      "user-agent": "Mozilla/5.0 BoschTWPriceMonitor/1.0",
      "accept": "application/json,text/plain,*/*"
    }
  });
  return {
    ok: response.ok,
    status: response.status,
    json: await response.json()
  };
}

async function scanOfficialReferencePrice(source) {
  const url = officialReferenceUrlForSource(source);
  if (!url) return null;
  try {
    const response = await fetchHtml(url);
    if (!response.ok) return {
      source: "bosch-home-shop",
      sourceUrl: url,
      status: "Fetch failed",
      httpStatus: response.status,
      checkedAt: now
    };
    return parseOfficialReferencePrice(response.html, url);
  } catch (error) {
    return {
      source: "bosch-home-shop",
      sourceUrl: url,
      status: "Fetch failed",
      error: String(error && error.message || error),
      checkedAt: now
    };
  }
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
    const referencePrice = await scanOfficialReferencePrice(source);
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
      referencePrice,
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

function metadataFromSkuRule(brand, sku) {
  const displaySku = String(sku || "").toUpperCase();
  const normalized = normalizeSku(sku);
  const result = {
    sku,
    brand,
    width: null,
    type: null,
    widthSource: null,
    typeSource: null,
    confidence: "none"
  };

  function apply(width, type, confidence = "medium", source = "sku-rule") {
    result.width = width || result.width;
    result.type = type || result.type;
    result.widthSource = width ? source : result.widthSource;
    result.typeSource = type ? source : result.typeSource;
    result.confidence = confidence;
  }

  if (brand === "Bosch") {
    if (/^SPS/.test(normalized)) apply("45cm", "Freestanding", "high");
    else if (/^SMS/.test(normalized)) apply("60cm", "Freestanding", "high");
    else if (/^SPV/.test(normalized)) apply("45cm", "Fully-integrated", "high");
    else if (/^SMV/.test(normalized)) apply("60cm", "Fully-integrated", "high");
    else if (/^SMI/.test(normalized)) apply("60cm", "Semi-integrated", "high");
  } else if (brand === "Asko") {
    if (/^DFS/.test(normalized)) apply("60cm", "Freestanding", "medium");
    else if (/^DFI/.test(normalized)) apply("60cm", "Fully-integrated", "medium");
    else if (/^DBI/.test(normalized)) apply("60cm", "Semi-integrated", "medium");
  } else if (brand === "Miele") {
    if (/XXL/.test(displaySku)) result.width = "60cm";
    if (/SCVI|CSCVI/.test(normalized)) apply("60cm", "Fully-integrated", "medium");
    else if (/CSCI|SCI/.test(normalized)) apply("60cm", "Semi-integrated", "medium");
    else if (/CSC$|SC$/.test(normalized)) apply("60cm", "Freestanding", "medium");
    else if (/^G[0-9]{4}/.test(normalized)) apply("60cm", null, "low");
  } else if (brand === "Electrolux") {
    if (/^(EFF|EBF|KSE|KEE)/.test(normalized)) apply("60cm", "Freestanding", "medium");
    else if (/^(KECA|EEZB|EEEM|EEM|KESB|EMF|EFS|EBS)/.test(normalized)) apply("60cm", "Fully-integrated", "low");
  } else if (brand === "Panasonic") {
    if (/^NPDFB/.test(normalized)) apply("60cm", "Freestanding", "medium");
    else if (/^(NP2KTB|NPBXW)/.test(normalized)) apply("60cm", "Fully-integrated", "medium");
    else if (/^NP(TH|TSK|TSP|TZ|FK|K1|DXK)/.test(normalized)) apply(null, "Countertop/compact", "low");
    else if (/^NP/.test(normalized)) apply("60cm", "Built-in", "low");
  } else if (brand === "Svago") {
    if (/^VE(7190|7850)$/.test(normalized)) apply("60cm", "Freestanding", "high");
    else if (/^VE8565$/.test(normalized)) apply("60cm", "Fully-integrated", "high");
    else if (/^VD6111$/.test(normalized)) apply("45cm", "Semi-integrated", "medium");
    else if (/^(VD6561|VE7545)$/.test(normalized)) apply("60cm", "Semi-integrated", "medium");
  } else if (brand === "Sakura") {
    if (/^E/.test(normalized)) apply("60cm", "Freestanding", "low");
  } else if (brand === "Amica") {
    if (/^[ZX]IV/.test(normalized)) apply("60cm", "Fully-integrated", "medium");
  } else if (brand === "Teka") {
    if (/^(DFI|DW857FIM)/.test(normalized)) apply("60cm", "Fully-integrated", "medium");
    else if (/^(DSI|DW857SI)/.test(normalized)) apply("60cm", "Semi-integrated", "medium");
  } else if (brand === "LG") {
    if (/^DFB/.test(normalized)) apply("60cm", "Freestanding", "medium");
  } else if (brand === "Whirlpool") {
    if (/^(WDFS|WFO)/.test(normalized)) apply("60cm", "Freestanding", "low");
  }

  if (result.width === "TBC") {
    result.width = null;
    result.widthSource = null;
  }
  return result;
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

function featureEvidenceFromText(text, url) {
  const normalized = safeDecode(normalizeHtml(text));
  const evidence = [];
  for (const rule of featureTagRules) {
    for (const pattern of rule.patterns) {
      const match = normalized.match(pattern);
      if (!match) continue;
      const index = Math.max(0, match.index || 0);
      evidence.push({
        tag: rule.tag,
        source: url,
        confidence: "low",
        evidence: normalized.slice(Math.max(0, index - 80), Math.min(normalized.length, index + 160)).trim()
      });
      break;
    }
  }
  return evidence;
}

function mergeFeatureTags(current, next) {
  return [...new Set([...(current || []), ...(next || [])])].sort();
}

function mergeFeatureEvidence(current, next) {
  const byKey = new Map();
  for (const item of [...(current || []), ...(next || [])]) {
    const key = `${item.tag}|${item.source}`;
    if (!byKey.has(key)) byKey.set(key, item);
  }
  return [...byKey.values()].sort((a, b) => String(a.tag).localeCompare(String(b.tag)));
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

function extractSkuFeatureEvidence(html, skus, url) {
  const text = safeDecode(normalizeHtml(html));
  const upper = text.toUpperCase();
  const evidenceBySku = new Map();
  for (const sku of skus) {
    const normalized = normalizeSku(sku);
    const compactUpper = upper.replace(/[^A-Z0-9]/g, "");
    let index = upper.indexOf(String(sku).toUpperCase());
    if (index < 0) index = compactUpper.indexOf(normalized);
    if (index < 0) continue;
    const start = Math.max(0, index - 800);
    const end = Math.min(text.length, index + 1200);
    const evidence = featureEvidenceFromText(text.slice(start, end), url);
    if (evidence.length) evidenceBySku.set(sku, evidence);
  }
  return evidenceBySku;
}

function featureObjectList(featureTagsBySku) {
  return [...featureTagsBySku.entries()]
    .sort((a, b) => String(a[0]).localeCompare(String(b[0])))
    .map(([sku, tags]) => ({ sku, tags }));
}

function featureEvidenceObjectList(featureEvidenceBySku) {
  return [...featureEvidenceBySku.entries()]
    .sort((a, b) => String(a[0]).localeCompare(String(b[0])))
    .map(([sku, evidence]) => ({ sku, evidence }));
}

function mergeProductMetadata(ruleMetadata, officialMetadata) {
  const official = officialMetadata || {};
  return {
    ...ruleMetadata,
    ...Object.fromEntries(Object.entries(official).filter(([, value]) => value != null && value !== "")),
    width: official.width || ruleMetadata.width,
    type: official.type || ruleMetadata.type,
    widthSource: official.width ? official.source || official.sourceUrl || "official" : ruleMetadata.widthSource,
    typeSource: official.type ? official.source || official.sourceUrl || "official" : ruleMetadata.typeSource,
    rspSource: official.rsp ? official.source || official.sourceUrl || "official" : null,
    confidence: official.confidence || ruleMetadata.confidence
  };
}

function metadataObjectList(brand, skus, officialMetadataBySku = new Map()) {
  return skus
    .map(sku => mergeProductMetadata(metadataFromSkuRule(brand, sku), officialMetadataBySku.get(normalizeSku(sku))))
    .filter(item => item.width || item.type)
    .sort((a, b) => String(a.sku).localeCompare(String(b.sku)));
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
    const featureEvidenceBySku = new Map();
    const officialMetadataBySku = new Map();
    const sourceResults = [];

    for (const url of urls) {
      try {
        if (source.brand === "Svago" && /\/Product\/category\/83013/i.test(url)) {
          const response = await fetchJson(url);
          const metadata = await parseSvagoOfficialMetadata(response.json, url);
          for (const item of metadata) {
            found.add(item.sku);
            officialMetadataBySku.set(normalizeSku(item.sku), item);
            if (Array.isArray(item.features) && item.features.length) {
              featureTagsBySku.set(item.sku, mergeFeatureTags(featureTagsBySku.get(item.sku), item.features));
              featureEvidenceBySku.set(item.sku, mergeFeatureEvidence(featureEvidenceBySku.get(item.sku), item.features.map(tag => ({
                tag,
                source: item.officialProductUrl,
                confidence: "high",
                evidence: tag
              }))));
            }
          }
          sourceResults.push({
            url,
            status: response.ok ? "Scanned" : "Fetch failed",
            httpStatus: response.status,
            candidateCount: metadata.length,
            parser: "svago-api"
          });
          continue;
        }
        if (source.brand === "Panasonic" && /categoryproductpagelist\.category\.pinfo\.full\.json/i.test(url)) {
          const response = await fetchJson(url);
          const metadata = parsePanasonicOfficialMetadata(response.json, url);
          for (const item of metadata) {
            found.add(item.sku);
            officialMetadataBySku.set(normalizeSku(item.sku), item);
            if (Array.isArray(item.features) && item.features.length) {
              featureTagsBySku.set(item.sku, mergeFeatureTags(featureTagsBySku.get(item.sku), item.features));
              featureEvidenceBySku.set(item.sku, mergeFeatureEvidence(featureEvidenceBySku.get(item.sku), item.features.map(tag => ({
                tag,
                source: item.officialProductUrl,
                confidence: "high",
                evidence: tag
              }))));
            }
          }
          sourceResults.push({
            url,
            status: response.ok ? "Scanned" : "Fetch failed",
            httpStatus: response.status,
            candidateCount: metadata.length,
            parser: "panasonic-json"
          });
          continue;
        }
        const response = await fetchHtml(url);
        if (source.brand === "Miele" && /miele\.kenk\.com\.tw\/application\/dish-washer/i.test(url)) {
          for (const item of parseMieleOfficialMetadata(response.html, url)) {
            officialMetadataBySku.set(normalizeSku(item.sku), item);
          }
        }
        const candidates = extractSkuCandidates(response.html, patterns);
        candidates.forEach(sku => found.add(sku));
        const extractedFeatures = extractSkuFeatureTags(response.html, candidates);
        for (const [sku, tags] of extractedFeatures.entries()) {
          featureTagsBySku.set(sku, mergeFeatureTags(featureTagsBySku.get(sku), tags));
        }
        const extractedEvidence = extractSkuFeatureEvidence(response.html, candidates, url);
        for (const [sku, evidence] of extractedEvidence.entries()) {
          featureEvidenceBySku.set(sku, mergeFeatureEvidence(featureEvidenceBySku.get(sku), evidence));
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
    const canonicalEvidenceBySku = new Map();
    for (const sku of foundSkus) {
      const evidence = [];
      for (const [rawSku, rawEvidence] of featureEvidenceBySku.entries()) {
        if (normalizeSku(rawSku) === normalizeSku(sku)) evidence.push(...rawEvidence);
      }
      const merged = mergeFeatureEvidence([], evidence);
      if (merged.length) canonicalEvidenceBySku.set(sku, merged);
    }
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
      productMetadataBySku: metadataObjectList(source.brand, foundSkus, officialMetadataBySku),
      featureTagsBySku: featureObjectList(featureTagsBySku),
      featureEvidenceBySku: featureEvidenceObjectList(canonicalEvidenceBySku),
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
