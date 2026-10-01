// Builds the assistant's knowledge base (RAG) into public/knowledge.json:
//   npm run knowledge                      rebuild
//   npm run knowledge -- --ask "question"  rebuild, then show what that question retrieves
//
// Passages come from:
//   - the data tree (src/data/layers.json): each dataset's place in the tree, what the app can
//     do with it, and its product metadata (every metadata_*_id / _value pair, whatever it's called)
//   - documents in knowledge/ (.md or .txt), split by heading and paragraph
// Each passage is embedded with the same model the browser uses (ragconfig.ts), and written
// with its vector as JSON; the browser ranks them by dot product (src/app/rag.ts).
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { pipeline } from "@huggingface/transformers";
import { CATALOG, datasetTags, productExtent } from "../src/app/datatree";
import { EMBED_DIM, EMBED_DTYPE, EMBED_MODEL, KNOWLEDGE_FILE, type Knowledge, type Passage } from "../src/app/ragconfig";

const DOCS_DIR = "knowledge";
const MAX_CHARS = 800; // the embedding model reads 256 word pieces and drops the rest; stay under
const LONG = 200; // metadata values longer than this get a passage of their own

// Product metadata comes as numbered pairs: metadata_one_id "Data Provider", metadata_one_value "…".
function metadataPairs(product: Record<string, unknown>) {
  return Object.keys(product)
    .map((k) => /^metadata_(\w+)_id$/.exec(k)?.[1])
    .filter((n): n is string => !!n)
    .map((n) => ({ name: String(product[`metadata_${n}_id`] ?? "").trim(), value: String(product[`metadata_${n}_value`] ?? "").trim() }))
    .filter((p) => p.name && p.value && p.value !== "null");
}

function datasetPassages(): Passage[] {
  return CATALOG.flatMap((d) => {
    const kind = d.kind === "gridded" ? "gridded (maps of a whole area)" : "point data (stations)";
    const pairs = d.layer.products.flatMap((p) => metadataPairs(p as unknown as Record<string, unknown>));
    const short = pairs.filter((p) => p.value.length <= LONG);
    const long = pairs.filter((p) => p.value.length > LONG);
    const extent = productExtent(d.layer);
    const base = { kind: d.kind, dataset: d.id, title: d.label, source: `Catalog: ${d.label}` };

    const overview = [
      `${d.label} is ${kind} in ${d.path.join(" > ")}.`,
      `Details: ${datasetTags(d)}.`,
      ...short.map((p) => `${p.name}: ${p.value}.`),
      extent ? `Coverage: longitude ${extent[0]} to ${extent[2]}, latitude ${extent[1]} to ${extent[3]}.` : "",
    ].filter(Boolean);
    return [
      { ...base, id: `${d.id}#overview`, text: overview.join(" ") },
      ...long.map((p, i) => ({ ...base, id: `${d.id}#${i + 1}`, text: `${d.label}, ${p.name}: ${p.value}` })),
    ];
  });
}

// Splits text into pieces of at most `max` characters, on paragraph then sentence boundaries.
function pack(paragraphs: string[], max: number) {
  const pieces: string[] = [];
  let cur = "";
  for (const para of paragraphs.flatMap((p) => (p.length > max ? p.match(/[^.!?]+[.!?]*\s*/g) ?? [p] : [p]))) {
    if (cur && cur.length + para.length + 1 > max) {
      pieces.push(cur.trim());
      cur = "";
    }
    cur += (cur ? "\n" : "") + para;
  }
  if (cur.trim()) pieces.push(cur.trim());
  return pieces;
}

function documentPassages(): Passage[] {
  let files: string[];
  try {
    files = readdirSync(DOCS_DIR).filter((f) => /\.(md|txt)$/i.test(f) && f.toLowerCase() !== "readme.md");
  } catch {
    return [];
  }
  return files.flatMap((file) => {
    const raw = readFileSync(join(DOCS_DIR, file), "utf8");
    const docTitle = /^#\s+(.+)$/m.exec(raw)?.[1].trim() ?? basename(file).replace(/\.\w+$/, "");
    // Sections by heading; each passage starts with its section title, for context.
    const sections = raw.split(/^(?=#{1,6}\s)/m);
    return sections.flatMap((section, s) => {
      const heading = /^#{1,6}\s+(.+)$/m.exec(section)?.[1].trim();
      const body = section.replace(/^#{1,6}\s+.+$/m, "").trim();
      if (!body) return [];
      const title = heading && heading !== docTitle ? `${docTitle}: ${heading}` : docTitle;
      const paragraphs = body.split(/\n\s*\n/).map((p) => p.replace(/\s+/g, " ").trim()).filter(Boolean);
      return pack(paragraphs, MAX_CHARS).map((text, i) => ({
        id: `doc:${file}#${s}.${i}`,
        kind: "document",
        dataset: null,
        title,
        source: `${DOCS_DIR}/${file}`,
        text: `${title}. ${text}`,
      }));
    });
  });
}

async function main() {
  const passages = [...datasetPassages(), ...documentPassages()];
  console.log(`${passages.length} passages (${passages.filter((p) => p.kind === "document").length} from ${DOCS_DIR}/)`);

  const embed = await pipeline("feature-extraction", EMBED_MODEL, { dtype: EMBED_DTYPE });
  const vectors: number[][] = [];
  for (let i = 0; i < passages.length; i += 32) {
    const out = await embed(passages.slice(i, i + 32).map((p) => p.text), { pooling: "mean", normalize: true });
    vectors.push(...(out.tolist() as number[][]));
  }

  // Five decimals is far finer than the q8 model's own precision, and keeps the file small.
  const knowledge: Knowledge = {
    model: EMBED_MODEL,
    dim: EMBED_DIM,
    passages: passages.map((p, i) => ({ ...p, vec: vectors[i].map((x) => Math.round(x * 1e5) / 1e5) })),
  };
  writeFileSync(`public/${KNOWLEDGE_FILE}`, JSON.stringify(knowledge));
  console.log(`Wrote public/${KNOWLEDGE_FILE}`);

  const ask = process.argv.indexOf("--ask");
  if (ask > 0 && process.argv[ask + 1]) {
    const question = process.argv[ask + 1];
    const q = (await embed(question, { pooling: "mean", normalize: true })).tolist()[0] as number[];
    const rows = knowledge.passages
      .map((p) => ({ score: +p.vec.reduce((s, x, i) => s + x * q[i], 0).toFixed(3), title: p.title, text: p.text.slice(0, 90) }))
      .sort((a, b) => b.score - a.score)
      .slice(0, 5);
    console.log(`\n"${question}"`);
    console.table(rows);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
