import type { VARIABLES } from "./query";

// Layers come from the SPC ocean middleware; each entry maps one of our query
// variables to a middleware layer id. Add rows here to make more data plottable.
// `alsoFor`: related variables this layer stands in for until they have their own dataset.
type Variable = (typeof VARIABLES)[number];
const MIDDLEWARE = "https://ocean-middleware.spc.int/middleware/api/layer_web_map";
const ENTRIES: { id: number; variable: Variable; alsoFor?: Variable[] }[] = [
  { id: 5, variable: "sst_anomaly", alsoFor: ["sst"] },
];

// The fields we use from /layer_web_map/<id>/?format=json.
export type SpcLayer = {
  id: number;
  url: string;
  layer_title: string;
  layer_type: string;
  layer_name: string;
  style: string;
  image_format: string;
  transparent: boolean;
  colormin: number;
  colormax: number;
  abovemaxcolor: string;
  belowmincolor: string;
  numcolorbands: number;
  logscale: boolean;
  timeIntervalStart: string;
  timeIntervalEnd: string;
  datetime_format: string;
  opacity: number;
  legend_url: string;
};

export type CatalogEntry = { variable: Variable; alsoFor: Variable[]; layer: SpcLayer };

// Fetched at runtime because the time range moves daily (the URL points at latest.ncml).
export async function loadCatalog(): Promise<CatalogEntry[]> {
  const results = await Promise.allSettled(
    ENTRIES.map(async (e) => {
      const res = await fetch(`${MIDDLEWARE}/${e.id}/?format=json`);
      if (!res.ok) throw new Error(`layer ${e.id}: HTTP ${res.status}`);
      return { variable: e.variable, alsoFor: e.alsoFor ?? [], layer: (await res.json()) as SpcLayer };
    }),
  );
  for (const r of results) if (r.status === "rejected") console.warn("Catalog entry failed", r.reason);
  return results
    .filter((r): r is PromiseFulfilledResult<CatalogEntry> => r.status === "fulfilled")
    .filter((r) => r.value.layer.layer_type === "WMS")
    .map((r) => r.value);
}

const day = (iso: string) => iso.slice(0, 10);
export const timeRange = (l: SpcLayer) => ({ min: day(l.timeIntervalStart), max: day(l.timeIntervalEnd) });

// Keeps a requested date inside what the server has.
export function clampDate(l: SpcLayer, date: string) {
  const { min, max } = timeRange(l);
  return date < min ? min : date > max ? max : date;
}

// ncWMS GetMap as a MapLibre raster tile template ({bbox-epsg-3857} is filled per tile).
export function wmsTiles(l: SpcLayer, date: string) {
  const params = new URLSearchParams({
    SERVICE: "WMS",
    VERSION: "1.3.0",
    REQUEST: "GetMap",
    LAYERS: l.layer_name,
    STYLES: l.style,
    FORMAT: l.image_format,
    TRANSPARENT: String(l.transparent),
    CRS: "EPSG:3857",
    WIDTH: "256",
    HEIGHT: "256",
    COLORSCALERANGE: `${l.colormin},${l.colormax}`,
    NUMCOLORBANDS: String(l.numcolorbands),
    ABOVEMAXCOLOR: l.abovemaxcolor,
    BELOWMINCOLOR: l.belowmincolor,
    LOGSCALE: String(l.logscale),
    TIME: `${date}T00:00:00Z`,
  });
  // URLSearchParams would escape the braces MapLibre needs to see.
  return `${l.url}?${params}&BBOX={bbox-epsg-3857}`;
}

// An exact match if there is one, otherwise a related stand-in (exact: false).
export function findDataset(catalog: CatalogEntry[], variable: Variable | null) {
  if (!variable) return null;
  const exact = catalog.find((c) => c.variable === variable);
  if (exact) return { entry: exact, exact: true };
  const related = catalog.find((c) => c.alsoFor.includes(variable));
  return related ? { entry: related, exact: false } : null;
}
