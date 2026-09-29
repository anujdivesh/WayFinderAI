import type { StyleSpecification } from "maplibre-gl";
import { clampDate, findDataset, timeRange, type CatalogEntry, type SpcLayer } from "./catalog";
import type { finalizeQuery, VARIABLES } from "./query";

export type FinalQuery = ReturnType<typeof finalizeQuery>;
export type BBox = [number, number, number, number];
type Variable = (typeof VARIABLES)[number];

// A layer in the workbench: a WMS dataset for one date, or, when no dataset
// matches the query yet, just the outline of the requested region.
export type Layer = {
  id: string;
  title: string;
  subtitle: string;
  color: string;
  visible: boolean;
  opacity: number;
  bbox?: BBox; // region to zoom to (and to outline, for non-WMS layers)
  wms?: { layer: SpcLayer; date: string };
  query?: FinalQuery;
};

export const VARIABLE_INFO: Record<Variable, { label: string; color: string }> = {
  sst: { label: "Sea surface temperature", color: "#e4572e" },
  sst_anomaly: { label: "SST anomaly", color: "#dc2626" },
  salinity: { label: "Salinity", color: "#2563eb" },
  chlorophyll: { label: "Chlorophyll", color: "#16a34a" },
  wave_height: { label: "Wave height", color: "#8b5cf6" },
  sea_level: { label: "Sea level", color: "#0891b2" },
};
const NO_VARIABLE = { label: "Region", color: "#64748b" };

const titleCase = (s: string) => s.replace(/\b\w/g, (c) => c.toUpperCase());

export function wmsLayer(entry: CatalogEntry, date?: string, bbox?: BBox, query?: FinalQuery): Layer {
  const l = entry.layer;
  return {
    id: crypto.randomUUID(),
    title: l.layer_title,
    subtitle: "",
    color: VARIABLE_INFO[entry.variable].color,
    visible: true,
    opacity: l.opacity,
    bbox,
    wms: { layer: l, date: clampDate(l, date ?? timeRange(l).max) },
    query,
  };
}

// Turns a chat query into a layer: the matching WMS dataset if the catalog has one,
// otherwise a region outline. Returns null when there is nothing to draw.
export function layerFromQuery(q: FinalQuery, catalog: CatalogEntry[]): { layer: Layer; note: string } | null {
  const found = findDataset(catalog, q.variable);
  const place = q.place ? titleCase(q.place.name) : null;
  if (found) {
    const { entry, exact } = found;
    // A map shows one day: the end of the requested range, kept inside what the server has.
    const layer = wmsLayer(entry, q.end, q.place?.bbox, q);
    const shifted = layer.wms!.date !== q.end ? ` (nearest available to ${q.end})` : "";
    const standIn = exact
      ? ""
      : `There's no ${VARIABLE_INFO[q.variable!].label.toLowerCase()} dataset yet, so this shows the closest one. `;
    return { layer, note: `${standIn}Added ${entry.layer.layer_title} for ${layer.wms!.date}${shifted}.` };
  }
  if (!q.place) return null;
  const info = q.variable ? VARIABLE_INFO[q.variable] : NO_VARIABLE;
  const agg = q.aggregation === "none" ? "" : ` · ${q.aggregation}`;
  return {
    layer: {
      id: crypto.randomUUID(),
      title: `${info.label} · ${place}`,
      subtitle: `${q.start} → ${q.end}${agg}`,
      bbox: q.place.bbox,
      color: info.color,
      visible: true,
      opacity: 0.35,
      query: q,
    },
    note: q.variable
      ? `No dataset for ${info.label.toLowerCase()} in the catalog yet, so only the region is shown.`
      : "Added the region to the map.",
  };
}

const raster = (url: string, attribution: string, maxzoom: number): StyleSpecification => ({
  version: 8,
  sources: { base: { type: "raster", tiles: [url], tileSize: 256, attribution, maxzoom } },
  layers: [{ id: "base", type: "raster", source: "base" }],
});

export const BASEMAPS: { id: string; label: string; style: string | StyleSpecification }[] = [
  {
    id: "ocean",
    label: "Esri Ocean",
    style: raster(
      "https://server.arcgisonline.com/ArcGIS/rest/services/Ocean/World_Ocean_Base/MapServer/tile/{z}/{y}/{x}",
      "Esri, GEBCO, NOAA, National Geographic, Garmin, HERE, Geonames.org, and other contributors",
      10,
    ),
  },
  { id: "positron", label: "OpenFreeMap Positron", style: "https://tiles.openfreemap.org/styles/positron" },
  {
    id: "imagery",
    label: "Esri Imagery",
    style: raster(
      "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",
      "Esri, Maxar, Earthstar Geographics, and the GIS User Community",
      18,
    ),
  },
];
