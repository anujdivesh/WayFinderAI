// Shared by the knowledge build script (scripts/build-knowledge.ts) and the browser (rag.ts):
// both must embed with the same model, or the vectors aren't comparable.
export const EMBED_MODEL = "Xenova/all-MiniLM-L6-v2";
export const EMBED_DTYPE = "q8"; // ~23 MB download in the browser, cached after the first time
export const EMBED_DIM = 384;
export const KNOWLEDGE_FILE = "knowledge.json"; // in public/

export type Passage = { id: string; kind: string; dataset: string | null; title: string; source: string; text: string };
// The file the build script writes: passages with unit-length vectors, so a dot product is
// the cosine similarity.
export type Knowledge = { model: string; dim: number; passages: (Passage & { vec: number[] })[] };
