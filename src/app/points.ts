import type { SpcLayer } from "./catalog";
import { formatPoint, type ChartRequest, type Series } from "./timeseries";

// Stations for a point-data layer, read from the layer's own URL. The response format is
// recognised by its shape, not by which dataset it is:
//   - GeoJSON FeatureCollection with Point features (GeoServer WFS)
//   - a JSON array (or { results: [...] }) of objects with latitude/longitude fields
//     (SPC ocean observations API)

export type StationPoint = {
  lon: number;
  lat: number;
  name: string;
  active: boolean;
  record: Record<string, unknown>; // the station's own fields, for filling URL templates
};

// The app works in 0..360° longitude (Pacific-centred), so western longitudes get +360:
// -159.78 (Rarotonga) becomes 200.22. Every station goes through this, whatever its source.
export const lon360 = (lon: number) => ((lon % 360) + 360) % 360;

type Row = Record<string, unknown>;

// The first readable name among common name fields, in this order.
const NAME_KEYS = [/^display_?name$/i, /^station_?na(me)?$/i, /^name$/i, /^location$/i, /^description$/i, /^station_?id$/i];
function nameOf(o: Row, fallback: string) {
  for (const re of NAME_KEYS) {
    const key = Object.keys(o).find((k) => re.test(k));
    if (key && typeof o[key] === "string" && (o[key] as string).trim()) return (o[key] as string).trim();
  }
  return fallback;
}

// "is_active": true/false or "Y"/"N"; missing means active.
function activeOf(o: Row) {
  const key = Object.keys(o).find((k) => /^is_?active$/i.test(k));
  const v = key ? o[key] : undefined;
  return !(v === false || v === "N" || v === "n" || v === 0);
}

const findKey = (o: Row, re: RegExp) => Object.keys(o).find((k) => re.test(k));

export async function fetchPoints(layer: SpcLayer, signal?: AbortSignal): Promise<StationPoint[]> {
  const stations = await readStations(layer, signal);
  // Exactly 0°, 0° means the source has no position for the station; drawing it would put it
  // off West Africa and stretch the layer's extent across the globe.
  const missing = stations.filter((p) => p.lon === 0 && p.lat === 0);
  if (missing.length) console.warn(`${layer.layer_title}: no position for`, missing.map((p) => p.name));
  return stations.filter((p) => !(p.lon === 0 && p.lat === 0));
}

async function readStations(layer: SpcLayer, signal?: AbortSignal): Promise<StationPoint[]> {
  const res = await fetch(layer.url, { signal });
  if (!res.ok) throw new Error(`${layer.layer_title}: HTTP ${res.status}`);
  const json = (await res.json()) as unknown;

  if (json && typeof json === "object" && (json as Row).type === "FeatureCollection") {
    const features = ((json as Row).features ?? []) as { geometry?: { type: string; coordinates: number[] }; properties?: Row; id?: string }[];
    return features
      .filter((f) => f.geometry?.type === "Point")
      .map((f, i) => {
        const [lon, lat] = f.geometry!.coordinates;
        const props = f.properties ?? {};
        return { lon: lon360(lon), lat, name: nameOf(props, String(f.id ?? i + 1)), active: activeOf(props), record: props };
      });
  }

  const rows = Array.isArray(json) ? json : Array.isArray((json as Row)?.results) ? ((json as Row).results as unknown[]) : null;
  if (!rows) throw new Error(`${layer.layer_title}: unrecognised response format`);
  return (rows as Row[]).flatMap((r, i) => {
    const latKey = findKey(r, /^(lat|latitude)$/i);
    const lonKey = findKey(r, /^(lon|lng|long|longitude)$/i);
    const lat = Number(latKey && r[latKey]);
    const lon = Number(lonKey && r[lonKey]);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) return [];
    return [{ lon: lon360(lon), lat, name: nameOf(r, String(i + 1)), active: activeOf(r), record: r }];
  });
}

// The box around a set of stations, for zooming (already 0..360, so continuous across 180°).
export function extentOf(points: StationPoint[]): [number, number, number, number] | undefined {
  if (!points.length) return undefined;
  const lons = points.map((p) => p.lon);
  const lats = points.map((p) => p.lat);
  return [Math.min(...lons), Math.min(...lats), Math.max(...lons), Math.max(...lats)];
}

// ---- Station time series -------------------------------------------------------------
// A point layer's timeseries_url is a template with {placeholders}, e.g.
//   https://ocean-obs-api.spc.int/insitu/get_data/station/{station_no}?limit=100
// Each placeholder is filled from the clicked station's record: a field of the same name,
// else the station's identifier field (station_id, …). Layers whose URL has no placeholder
// (or points at another API with a token) can't chart per station.

const PLACEHOLDER = /\{(\w+)\}/g;
const ID_KEYS = [/^station_?id$/i, /^station_?no$/i, /^spotter_?id$/i, /^id$/i];

export const stationTemplate = (l: SpcLayer) =>
  l.timeseries_url && /\{\w+\}/.test(l.timeseries_url) && !/REDACTED/.test(l.timeseries_url) ? l.timeseries_url : null;

function fillTemplate(template: string, record: Record<string, unknown>) {
  return template.replace(PLACEHOLDER, (m, name: string) => {
    const direct = Object.keys(record).find((k) => k.toLowerCase() === name.toLowerCase());
    const idKey = direct ?? ID_KEYS.map((re) => Object.keys(record).find((k) => re.test(k))).find(Boolean);
    const v = idKey ? record[idKey] : undefined;
    return v === undefined || v === null ? m : encodeURIComponent(String(v).trim());
  });
}

const TIME_KEY = /^(time|timestamp|date|datetime)$/i;

// "sea_level (m)" → label "Sea level", unit "m".
function splitLabel(key: string) {
  const m = /^(.*?)\s*\(([^)]+)\)\s*$/.exec(key);
  const name = (m ? m[1] : key).replace(/_/g, " ").trim();
  return { label: name.charAt(0).toUpperCase() + name.slice(1), unit: m ? m[2] : "" };
}

// Reads { data_labels?, data: [{ var: value, time }, …] } (or a bare array of records):
// every numeric field except time becomes a series, in data_labels order when given.
export async function fetchStationSeries(layer: SpcLayer, station: StationPoint, signal?: AbortSignal): Promise<Series[]> {
  const template = stationTemplate(layer);
  if (!template) return [];
  const res = await fetch(fillTemplate(template, station.record), { signal });
  if (res.status === 404) return []; // the API's "Active station not found"
  if (!res.ok) throw new Error(`${station.name}: HTTP ${res.status}`);
  const json = (await res.json()) as { data?: unknown; data_labels?: string } | unknown[];
  const rows = (Array.isArray(json) ? json : Array.isArray(json.data) ? json.data : []) as Row[];
  if (!rows.length) return [];

  const timeKey = Object.keys(rows[0]).find((k) => TIME_KEY.test(k));
  if (!timeKey) return [];
  // The API declares a station's variables in data_labels; plot exactly those (records can
  // also carry e.g. a drifting buoy's position). Without it, every numeric field.
  const labelled = !Array.isArray(json) && typeof json.data_labels === "string" ? json.data_labels.split(",").map((k) => k.trim()) : [];
  const keys = (labelled.length ? labelled : Object.keys(rows[0])).filter(
    (k) => k !== timeKey && rows.some((r) => typeof r[k] === "number"),
  );
  // Oldest first (the API returns newest first).
  const sorted = [...rows].sort((a, b) => Date.parse(String(a[timeKey])) - Date.parse(String(b[timeKey])));
  const times = sorted.map((r) => new Date(String(r[timeKey])).toISOString());
  return keys.map((k) => ({
    variable: k,
    ...splitLabel(k),
    times,
    values: sorted.map((r) => (typeof r[k] === "number" ? (r[k] as number) : null)),
  }));
}

export function stationChart(layer: SpcLayer, station: StationPoint): ChartRequest {
  return {
    title: station.name,
    subtitle: `${layer.layer_title} · ${formatPoint(station)} · latest records`,
    point: station,
    load: (signal) => fetchStationSeries(layer, station, signal),
    empty: station.active ? "This station has no recent data." : "This station is inactive and has no recent data.",
  };
}

// The station nearest a point (for "time series near Fiji"), in degrees on a 0..360 grid.
export function nearestStation(stations: StationPoint[], p: { lon: number; lat: number }) {
  const lon = lon360(p.lon);
  let best: StationPoint | null = null;
  let bestD = Infinity;
  for (const s of stations) {
    const dLon = Math.min(Math.abs(s.lon - lon), 360 - Math.abs(s.lon - lon)) * Math.cos((p.lat * Math.PI) / 180);
    const d = dLon * dLon + (s.lat - p.lat) ** 2;
    if (d < bestD) [best, bestD] = [s, d];
  }
  return best;
}
