import MiniSearch from "minisearch";
import { CATALOG, STEP_ORDER, type CatalogEntry } from "./datatree";

// Full-text search over the datasets in the data tree. Everything indexed comes from the
// synced middleware JSON (titles, product names and descriptions, variable names, THREDDS
// paths), so new or renamed layers are searchable after `npm run sync:layers` with no
// code changes. The top hits become the shortlist the model chooses from.

type Doc = {
  id: string;
  title: string;
  theme: string;
  keywords: string;
  description: string;
};

// Everyday English words that would otherwise match descriptions ("plot it", "what is…").
// A generic list: nothing here is about particular datasets.
const STOPWORDS = new Set(
  ("a an and are as at be but by can could data do does for from get give have how i in into is it its " +
    "latest me my near of on or over plot please all show map display draw add load same so than that the " +
    "their them then there these this those to up us was what when where which who why will with would " +
    "you your around about any some tell want see look time series chart graph now today").split(" "),
);

// Case and plural folding; drops stopwords. No dataset-specific rules.
function processTerm(term: string) {
  const t = term.toLowerCase();
  if (STOPWORDS.has(t)) return null;
  if (t.length > 4 && t.endsWith("ies")) return t.slice(0, -3) + "y";
  if (t.length > 3 && t.endsWith("s") && !t.endsWith("ss")) return t.slice(0, -1);
  return t;
}

function toDoc(d: CatalogEntry): Doc {
  const l = d.layer;
  // Short technical names people also type: variable names (sst, anom, sla…), labels,
  // and the THREDDS path segments (…/nrt/daily/mhw/latest.ncml).
  const path = (() => {
    try {
      return new URL(l.url).pathname;
    } catch {
      return "";
    }
  })().replace(/^\/thredds\/wms\//, "");
  const keywords = [
    l.layer_name,
    l.timeseries_variables,
    l.timeseries_variable_label,
    path.replace(/\.(nc|ncml)$/g, ""),
    ...l.products.map((p) => p.name),
    d.run !== "observed" ? d.run : "",
    d.step,
  ];
  return {
    id: d.id,
    title: d.label,
    theme: d.path.at(-1) ?? "",
    keywords: keywords.filter(Boolean).join(" "),
    description: d.description ?? "",
  };
}

const byId = new Map(CATALOG.map((d) => [d.id, d]));
const order = new Map(CATALOG.map((d, i) => [d.id, i]));

const index = new MiniSearch<Doc>({
  fields: ["title", "theme", "keywords", "description"],
  // Split on anything that isn't a letter or digit, so "sig_wav_ht" and "sst/anomalies" split
  // too; also join neighbouring words, so "wave buoy" finds "Wavebuoy" and vice versa.
  tokenize: (text) => {
    const words = text.split(/[^\p{L}\p{N}]+/u).filter(Boolean);
    return [...words, ...words.slice(1).map((w, i) => words[i] + w)];
  },
  processTerm,
  searchOptions: {
    boost: { title: 3, theme: 2, keywords: 2, description: 0.5 },
    prefix: (term) => term.length >= 4, // "chloro" → chlorophyll
    fuzzy: (term) => (term.length >= 6 ? 0.2 : false), // typos in longer words only
    combineWith: "OR",
  },
});
index.addAll(CATALOG.map(toDoc));


// The datasets a message most likely refers to, best first. Hits far below the top one
// are dropped; ties keep the tree's order (observed before forecast, finer steps first).
export function shortlist(message: string, limit = 6): CatalogEntry[] {
  const asksRun = /\b(forecasts?|outlooks?|predict\w*|projections?|hindcasts?)\b/i.test(message);
  const hits = index.search(message, {
    // Rank by what the tree knows, not by names: forecasts/hindcasts rank below observations
    // unless the message asks for them.
    boostDocument: (id) => {
      const d = byId.get(id)!;
      // Near-ties go to the finer time step (daily before monthly), as the tree orders them,
      // and to datasets that can do more (a time series as well as a map).
      const step = Math.max(0, STEP_ORDER.indexOf(d.step));
      const capable = d.actions.includes("timeseries") ? 1.25 : 1;
      return (d.run !== "observed" && !asksRun ? 0.8 : 1) * (1 - 0.03 * step) * capable;
    },
  });
  if (!hits.length) return [];
  const top = hits[0].score;
  return hits
    .filter((h) => h.score >= top * 0.25)
    .sort((a, b) => b.score - a.score || order.get(a.id)! - order.get(b.id)!)
    .slice(0, limit)
    .map((h) => byId.get(h.id)!);
}

// The top hit only when it clearly beats the rest (or is the only one); null when the
// message could mean several datasets, so the app asks instead of guessing.
export function clearMatch(message: string): CatalogEntry | null {
  const list = shortlist(message, 2);
  if (list.length === 1) return list[0];
  if (list.length < 2) return null;
  const [a, b] = index.search(message).slice(0, 2);
  return a.score >= b.score * 1.5 ? byId.get(a.id)! : null;
}

export const datasetById = (id: string | null | undefined) => (id ? (byId.get(id) ?? null) : null);
