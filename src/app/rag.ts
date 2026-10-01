import { asset } from "./asset";
import { EMBED_DTYPE, EMBED_MODEL, KNOWLEDGE_FILE, type Knowledge, type Passage } from "./ragconfig";

// Retrieval for the chat model: embeds the question with the same model the build script
// used (scripts/build-knowledge.ts) and returns the closest passages from public/knowledge.json.
// A few hundred vectors rank in well under a millisecond in plain JS, so no database is needed.

type Embed = (text: string) => Promise<Float32Array>;
type Index = { embed: Embed; passages: Passage[]; vecs: Float32Array[] };

let loading: Promise<Index> | null = null;

async function load(): Promise<Index> {
  // Loaded on demand: transformers.js and the embedding model are only needed for chat.
  const [{ pipeline }, knowledge] = await Promise.all([
    import("@huggingface/transformers"),
    fetch(asset(`/${KNOWLEDGE_FILE}`)).then((r) => {
      if (!r.ok) throw new Error(`${KNOWLEDGE_FILE}: HTTP ${r.status} (run npm run knowledge)`);
      return r.json() as Promise<Knowledge>;
    }),
  ]);
  if (knowledge.model !== EMBED_MODEL) throw new Error(`${KNOWLEDGE_FILE} was built with ${knowledge.model}`);
  const extractor = await pipeline("feature-extraction", EMBED_MODEL, { dtype: EMBED_DTYPE });
  const embed: Embed = async (text) => (await extractor(text, { pooling: "mean", normalize: true })).data as Float32Array;
  return {
    embed,
    passages: knowledge.passages,
    vecs: knowledge.passages.map((p) => Float32Array.from(p.vec)),
  };
}

// Starts loading in the background, e.g. while the chat model downloads. Safe to call twice.
export function warmRag() {
  loading ??= load();
  // A failed load is retried on the next call instead of being cached.
  loading.catch(() => (loading = null));
}

// The passages closest to `question`, best first, dropping weak matches.
export async function retrieve(question: string, k = 4, minScore = 0.3): Promise<(Passage & { score: number })[]> {
  warmRag();
  const { embed, passages, vecs } = await loading!;
  const q = await embed(question);
  return vecs
    .map((v, i) => {
      let score = 0;
      for (let j = 0; j < v.length; j++) score += v[j] * q[j];
      return { ...passages[i], score };
    })
    .filter((p) => p.score >= minScore)
    .sort((a, b) => b.score - a.score)
    .slice(0, k);
}
