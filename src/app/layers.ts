import { clampDate, timeRange, type SpcLayer } from "./catalog";
import { productExtent, type Action, type CatalogEntry } from "./datatree";
import { stationTemplate, type StationPoint } from "./points";
import type { finalizeQuery } from "./query";
import { datasetById } from "./search";
import { supportsTimeseries } from "./timeseries";

export type FinalQuery = ReturnType<typeof finalizeQuery>;
export type BBox = [number, number, number, number];

// A layer in the workbench: a gridded dataset for one date (WMS), a point dataset's
// stations, or, when no dataset was named, just the outline of the requested region.
export type Layer = {
  id: string;
  title: string;
  subtitle: string;
  color: string;
  visible: boolean;
  opacity: number;
  bbox?: BBox; // the place asked for: zoomed to on add (and outlined, for region layers)
  extent?: BBox; // the dataset's own coverage (product metadata), for "zoom to layer"
  wms?: { layer: SpcLayer; date: string; actions: Action[] }; // actions from the data tree
  points?: { layer: SpcLayer; stations: StationPoint[] | null; error?: string }; // null while loading
  query?: FinalQuery;
};

// Categorical palette (the dataviz reference palette), handed out in fixed order so a
// layer keeps its colour; a colour is reused only once all eight are on the map.
const PALETTE = ["#2a78d6", "#eb6834", "#1baf7a", "#eda100", "#e87ba4", "#008300", "#4a3aa7", "#e34948"];
export const nextColor = (used: string[]) => PALETTE.find((c) => !used.includes(c)) ?? PALETTE[used.length % PALETTE.length];

const titleCase = (s: string) => s.replace(/\b\w/g, (c) => c.toUpperCase());

function wmsLayer(entry: CatalogEntry, color: string, date?: string, bbox?: BBox, query?: FinalQuery): Layer {
  const l = entry.layer;
  return {
    id: crypto.randomUUID(),
    title: l.layer_title,
    subtitle: "",
    color,
    visible: true,
    opacity: l.opacity ?? 1, // one middleware layer has null
    bbox,
    extent: productExtent(entry.layer),
    wms: { layer: l, date: clampDate(l, date ?? timeRange(l).max), actions: entry.actions },
    query,
  };
}

function pointLayer(entry: CatalogEntry, color: string, bbox?: BBox, query?: FinalQuery): Layer {
  return {
    id: crypto.randomUUID(),
    title: entry.layer.layer_title,
    subtitle: "Loading stations…",
    color,
    visible: true,
    opacity: 1,
    bbox,
    extent: productExtent(entry.layer),
    points: { layer: entry.layer, stations: null },
    query,
  };
}

// Turns a routed query into a layer, by the dataset's kind in the data tree. Without a
// dataset, a known place becomes a region outline. Returns null when there is nothing to draw.
export function layerFromQuery(q: FinalQuery, color: string): { layer: Layer; note: string } | null {
  const entry = datasetById(q.dataset);
  if (entry?.kind === "gridded") {
    // A map shows one day: the end of the requested range, kept inside what the server has.
    const layer = wmsLayer(entry, color, q.userDates ? q.end : undefined, q.place?.bbox, q);
    const shifted = q.userDates && layer.wms!.date !== q.end ? ` (nearest available to ${q.end})` : "";
    return { layer, note: `Added ${entry.label} for ${layer.wms!.date}${shifted}.` };
  }
  if (entry?.kind === "point") {
    return { layer: pointLayer(entry, color, q.place?.bbox, q), note: `Added ${entry.label}.` };
  }
  if (!q.place) return null;
  const place = titleCase(q.place.name);
  return {
    layer: {
      id: crypto.randomUUID(),
      title: `Region · ${place}`,
      subtitle: "",
      bbox: q.place.bbox,
      color,
      visible: true,
      opacity: 0.35,
      query: q,
    },
    note: `Showing ${place}. Name a dataset to plot data there.`,
  };
}

// Time series need both: the tree allows it, and the layer itself has it switched on.
export const canChart = (l: Layer) =>
  !!l.wms && l.wms.actions.includes("timeseries") && supportsTimeseries(l.wms.layer);

// Point layers chart per station when their timeseries_url is a per-station template.
export const canChartStations = (l: Layer) => !!l.points && !!stationTemplate(l.points.layer);
