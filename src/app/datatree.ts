import snapshot from "../data/layers.json";
import { supportsTimeseries, timeRange, unitOf, type SpcLayer } from "./catalog";
import { stationTemplate } from "./points";

// The data tree: what data exists, where it comes from, and what can be done with it.
// Built entirely from the middleware snapshot in src/data/layers.json (npm run sync:layers):
// no dataset names or themes are written here, so new layers appear after a re-sync.
//
//   Data
//   ├── Gridded data            layer_type WMS, WMS_FORECAST, WMS_HINDCAST
//   │   ├── THREDDS (ncWMS)     → product group → dataset     map; time series where enabled
//   │   └── Zarr                (coming soon)
//   └── Point data              layer_type SOFAR, TIDE, WFS
//       └── station source      → dataset                     map of stations
//
// Groups under a source are the middleware's own product groups: the "[…]" label that
// starts a product name, e.g. "[Sea Surface Temperature] {1} Sea Surface Temperature - Daily".
// Code reads `kind` to pick a handler and `actions` to decide what is allowed; the
// assistant reads dataOutline(). Print it with: npm run tree

export type Action = "map" | "timeseries";
export const ACTION_LABEL: Record<Action, string> = { map: "map", timeseries: "time series" };

// Product metadata from /webapp_product/, attached to its layer by the sync script.
export type Product = {
  id: number;
  name: string;
  metadata_one_value: string | null; // "Data Description"
  metadata_three_value: string | null; // "Data Provider"
  has_bbox: boolean;
  west_bound_longitude: number | null;
  east_bound_longitude: number | null;
  south_bound_latitude: number | null;
  north_bound_latitude: number | null;
};

// The product's declared coverage, for zooming to a layer.
export function productExtent(l: LayerRecord): [number, number, number, number] | undefined {
  const p = l.products.find((x) => x.has_bbox && x.west_bound_longitude !== null);
  if (!p) return undefined;
  const { west_bound_longitude: w, south_bound_latitude: s, east_bound_longitude: e, north_bound_latitude: n } = p;
  return w !== null && s !== null && e !== null && n !== null ? [w, s, e, n] : undefined;
}
export type LayerRecord = SpcLayer & { enabled: boolean; products: Product[] };

function stationActions(l: LayerRecord): Action[] {
  return stationTemplate(l) ? ["map", "timeseries"] : ["map"];
}

// Which layer types the app has a handler for, and what that handler can do.
// This is the only place that knows about layer types.
const HANDLERS: Record<string, { kind: "gridded" | "point"; source: string; actions: (l: LayerRecord) => Action[] }> = {
  WMS: { kind: "gridded", source: "THREDDS (ncWMS)", actions: (l) => (supportsTimeseries(l) ? ["map", "timeseries"] : ["map"]) },
  WMS_FORECAST: { kind: "gridded", source: "THREDDS (ncWMS)", actions: (l) => (supportsTimeseries(l) ? ["map", "timeseries"] : ["map"]) },
  WMS_HINDCAST: { kind: "gridded", source: "THREDDS (ncWMS)", actions: (l) => (supportsTimeseries(l) ? ["map", "timeseries"] : ["map"]) },
  // Stations chart when the layer's timeseries_url is a per-station template ({station_no}).
  SOFAR: { kind: "point", source: "SPC ocean observations API", actions: stationActions },
  TIDE: { kind: "point", source: "SPC GeoServer (WFS)", actions: stationActions },
  WFS: { kind: "point", source: "SPC GeoServer (WFS)", actions: stationActions },
};

export type DatasetNode = {
  type: "dataset";
  id: string;
  label: string;
  kind: "gridded" | "point";
  run: "observed" | "forecast" | "hindcast";
  step: string; // "daily", "monthly", …
  actions: Action[];
  description?: string;
  provider?: string;
  layer: LayerRecord;
};

export type GroupNode = {
  type: "group";
  id: string;
  label: string;
  note?: string; // shown to the assistant, e.g. "coming soon"
  children: (GroupNode | DatasetNode)[];
};

// The middleware's datetime_format codes, as words. Unknown codes are shown lower-cased.
const STEPS: Record<string, string> = {
  HOURLY: "hourly",
  DAILY: "daily",
  WFS_DAILY: "daily",
  WEEKLY: "weekly",
  WEEKLY_NRT: "weekly",
  MONTHLY: "monthly",
  "3MONTHLY": "3-monthly",
  "3MONTHLY_ORIG": "3-monthly",
  "3MONTHLY_SEASONAL": "seasonal",
  "6MONTHLY": "6-monthly",
  "12MONTHLY": "12-monthly",
};
export const STEP_ORDER = ["hourly", "daily", "weekly", "monthly", "3-monthly", "seasonal", "6-monthly", "12-monthly"];
const RUN_ORDER = ["observed", "hindcast", "forecast"];

const layers = (snapshot.layers as unknown as LayerRecord[]).filter(
  (l) => l.enabled && !/\[DELETED\]/i.test(l.layer_title) && HANDLERS[l.layer_type],
);

const productGroup = (l: LayerRecord) => /^\s*\[([^\]]+)\]/.exec(l.products[0]?.name ?? "")?.[1]?.trim() ?? null;
const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

function dataset(l: LayerRecord): DatasetNode {
  const h = HANDLERS[l.layer_type];
  return {
    type: "dataset",
    id: `layer-${l.id}`,
    label: l.layer_title,
    kind: h.kind,
    run: l.layer_type.endsWith("_FORECAST") ? "forecast" : l.layer_type.endsWith("_HINDCAST") ? "hindcast" : "observed",
    step: STEPS[l.datetime_format] ?? l.datetime_format.toLowerCase(),
    actions: h.actions(l),
    description: l.products[0]?.metadata_one_value ?? undefined,
    provider: l.products[0]?.metadata_three_value ?? undefined,
    layer: l,
  };
}

// Observed before hindcast before forecast; finer time steps first; layers with metadata first.
const rank = (d: DatasetNode) =>
  RUN_ORDER.indexOf(d.run) * 100 + (STEP_ORDER.indexOf(d.step) + 1) * 10 + (d.layer.products.length ? 0 : 1);
const byRank = (a: GroupNode | DatasetNode, b: GroupNode | DatasetNode) =>
  a.type === "group" || b.type === "group" ? 0 : rank(a) - rank(b);

// Same title, type and step twice (e.g. layers 7 and 20): keep the one with product metadata.
function dedupe(ls: LayerRecord[]) {
  const seen = new Map<string, LayerRecord>();
  for (const l of ls) {
    const key = `${l.layer_title}|${l.layer_type}|${l.datetime_format}`;
    const prev = seen.get(key);
    if (!prev || (!prev.products.length && l.products.length)) seen.set(key, l);
  }
  return [...seen.values()];
}

// A source's datasets, grouped by the middleware's product groups; ungrouped ones sit directly under it.
function sourceNode(label: string, ls: LayerRecord[]): GroupNode {
  const groups = new Map<string, GroupNode>();
  const loose: DatasetNode[] = [];
  for (const l of dedupe(ls)) {
    const g = productGroup(l);
    if (!g) {
      loose.push(dataset(l));
      continue;
    }
    if (!groups.has(g)) groups.set(g, { type: "group", id: slug(g), label: g, children: [] });
    groups.get(g)!.children.push(dataset(l));
  }
  for (const g of groups.values()) g.children.sort(byRank);
  return { type: "group", id: slug(label), label, children: [...groups.values(), ...loose.sort(byRank)] };
}

function kindNode(kind: "gridded" | "point", label: string, extra: GroupNode[] = []): GroupNode {
  const sources = new Map<string, LayerRecord[]>();
  for (const l of layers.filter((x) => HANDLERS[x.layer_type].kind === kind)) {
    const s = HANDLERS[l.layer_type].source;
    sources.set(s, [...(sources.get(s) ?? []), l]);
  }
  return { type: "group", id: kind, label, children: [...[...sources].map(([s, ls]) => sourceNode(s, ls)), ...extra] };
}

export const DATA_TREE: GroupNode = {
  type: "group",
  id: "data",
  label: "Data",
  children: [
    kindNode("gridded", "Gridded data", [
      { type: "group", id: "zarr", label: "Zarr", note: "coming soon, no datasets yet", children: [] },
    ]),
    kindNode("point", "Point data (stations)"),
  ],
};

export const SNAPSHOT_DATE = snapshot.syncedAt.slice(0, 10);

// Every dataset leaf, with the labels of the groups above it.
export type DatasetInfo = DatasetNode & { path: string[] };
export function datasets(node: GroupNode = DATA_TREE, path: string[] = []): DatasetInfo[] {
  const at = node === DATA_TREE ? path : [...path, node.label];
  return node.children.flatMap((c) => (c.type === "group" ? datasets(c, at) : [{ ...c, path: at }]));
}

// The tree as indented text. `describe` renders a dataset line, or null to skip it.
export function outline(describe: (d: DatasetNode) => string | null, node: GroupNode = DATA_TREE, depth = 0): string {
  const lines: string[] = [];
  const inner = node === DATA_TREE ? depth : depth + 1;
  if (node !== DATA_TREE) lines.push(`${"  ".repeat(depth)}- ${node.label}${node.note ? ` (${node.note})` : ""}`);
  for (const c of node.children) {
    if (c.type === "group") lines.push(outline(describe, c, inner));
    else {
      const text = describe(c);
      if (text) lines.push(`${"  ".repeat(inner)}- ${text}`);
    }
  }
  return lines.filter(Boolean).join("\n");
}

// Every dataset the app can display (all leaves have a handler; Zarr has none yet).
export type CatalogEntry = DatasetInfo;
export const CATALOG: CatalogEntry[] = datasets();

// Short details for a dataset, used in the prompt outline and the router's shortlist.
export function datasetTags(d: DatasetNode) {
  const tags = [d.kind === "point" ? "stations" : d.step, d.run !== "observed" ? d.run : ""];
  if (d.kind === "gridded") {
    const { min, max } = timeRange(d.layer);
    tags.push(`${min} to ${max}`, unitOf(d.layer));
  }
  tags.push(`can: ${d.actions.map((a) => ACTION_LABEL[a]).join(", ")}`);
  return tags.filter(Boolean).join(", ");
}

// The tree for the assistant's prompt, one line per dataset.
export const dataOutline = () => outline((d) => `${d.label}: ${datasetTags(d)}`);

// The tree's first levels in words, for "which dataset?" replies: each kind of data with
// its product groups and ungrouped datasets.
export function treeSummary(limit = 10) {
  return DATA_TREE.children
    .filter((k): k is GroupNode => k.type === "group")
    .map((kind) => {
      const names = kind.children.flatMap((src) => (src.type === "group" ? src.children.map((c) => c.label) : [src.label]));
      return `${kind.label}: ${names.slice(0, limit).join(", ")}${names.length > limit ? ", …" : ""}`;
    })
    .join("\n");
}
