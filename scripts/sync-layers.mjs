// Snapshots the SPC ocean middleware into src/data/layers.json, so the app reads
// layer config from a file instead of calling the API at runtime.
//
//   npm run sync:layers
//
// Layers:   /layer_web_map/<id>/   for ids FIRST..LAST (missing ids are skipped)
// Products: /webapp_product/       (descriptive metadata; product.layer_information = layer id)
//
// Re-run it to pick up new layers and to move time ranges forward: layers backed by
// latest.ncml gain a day of data daily, but the snapshot keeps the range it was synced with.
import { mkdirSync, writeFileSync } from "node:fs";

const API = "https://ocean-middleware.spc.int/middleware/api";
const FIRST = 1;
const LAST = 70;
const OUT = "src/data/layers.json";

async function getJson(url) {
  const res = await fetch(`${url}?format=json`);
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  return res.json();
}

// A few requests at a time, to be gentle on the middleware.
async function mapLimit(items, limit, fn) {
  const out = [];
  for (let i = 0; i < items.length; i += limit) out.push(...(await Promise.all(items.slice(i, i + limit).map(fn))));
  return out;
}

const ids = Array.from({ length: LAST - FIRST + 1 }, (_, i) => FIRST + i);
const layers = (await mapLimit(ids, 6, (id) => getJson(`${API}/layer_web_map/${id}/`))).filter(Boolean);
const products = (await getJson(`${API}/webapp_product/`)) ?? [];

// Attach each product's metadata to the layer it describes.
const byLayer = new Map();
for (const p of products) {
  if (!byLayer.has(p.layer_information)) byLayer.set(p.layer_information, []);
  byLayer.get(p.layer_information).push(p);
}
// The snapshot ships to browsers, so credentials in URLs (e.g. a Sofar API token in
// timeseries_url) are removed from every string field.
const SECRET = /([?&](?:token|access_token|api_?key|key|password|secret)=)[^&"\s]*/gi;
const redact = (v) =>
  typeof v === "string"
    ? v.replace(SECRET, "$1REDACTED")
    : Array.isArray(v)
      ? v.map(redact)
      : v && typeof v === "object"
        ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, redact(x)]))
        : v;
const joined = layers.map((l) => redact({ ...l, products: byLayer.get(l.id) ?? [] }));
const redacted = JSON.stringify(layers).match(SECRET)?.length ?? 0;
// Products pointing at a layer id that doesn't exist (usually a deleted layer).
const orphans = products.filter((p) => !layers.some((l) => l.id === p.layer_information));

mkdirSync("src/data", { recursive: true });
writeFileSync(
  OUT,
  JSON.stringify({ syncedAt: new Date().toISOString(), source: API, range: [FIRST, LAST], layers: joined }, null, 2) + "\n",
);

const missing = ids.filter((id) => !layers.some((l) => l.id === id));
console.log(`Wrote ${OUT}: ${joined.length} layers (ids ${FIRST}-${LAST}), ${products.length} products.`);
console.log(`  No layer at: ${missing.join(", ") || "none"}`);
console.log(`  Credentials removed from URLs: ${redacted}`);
console.log(`  Layers without a product: ${joined.filter((l) => !l.products.length).map((l) => l.id).join(", ") || "none"}`);
if (orphans.length) {
  console.log(`  Products whose layer doesn't exist (product→layer): ${orphans.map((p) => `${p.id}→${p.layer_information}`).join(", ")}`);
}
