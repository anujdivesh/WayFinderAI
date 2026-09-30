import { clampDate, timeRange, unitOf, type SpcLayer } from "./catalog";

export { supportsTimeseries } from "./catalog";

// Point time series for any gridded (ncWMS) layer, driven entirely by the layer's
// middleware fields: timeseries_url (a query-string template appended to `url`),
// timeseries_variables and timeseries_variable_label.

export type Point = { lon: number; lat: number };
export type Series = { variable: string; label: string; unit: string; times: string[]; values: (number | null)[] };
export type SeriesRequest = { layer: SpcLayer; point: Point; start: string; end: string; pointLabel?: string };

// What the chart panel shows: any source that can load a set of series (a gridded layer at a
// point, a station's record, …). The panel only knows these fields.
export type ChartRequest = {
  title: string;
  subtitle: string;
  point: Point; // where the pin goes
  load: (signal: AbortSignal) => Promise<Series[]>;
  empty: string; // shown when every value is missing
};

// A gridded (ncWMS) time series as a chart request.
export function gridChart(req: SeriesRequest): ChartRequest {
  return {
    title: req.layer.layer_title,
    subtitle: `${req.pointLabel ? `${req.pointLabel} · ` : ""}${formatPoint(req.point)} · ${req.start} → ${req.end}`,
    point: req.point,
    load: (signal) => fetchSeries(req, signal),
    empty: "No data at this point; it may be on land. Click a point in the ocean.",
  };
}

// The start/end to request: what the user asked for, kept inside the layer's range.
// With no dates given, the whole available range (as the existing portal does).
export function seriesRange(l: SpcLayer, start?: string | null, end?: string | null) {
  const r = timeRange(l);
  return { start: clampDate(l, start ?? r.min), end: clampDate(l, end ?? r.max) };
}

const split = (s: string | null) => (s ?? "").split(",").map((v) => v.trim()).filter(Boolean);

// Fills the template for one variable. A tiny 3×3-pixel box centred on the point,
// with the query pixel in the middle, asks ncWMS for exactly that location.
function requestUrl(l: SpcLayer, variable: string, p: Point, start: string, end: string) {
  const d = 0.05;
  const fill: Record<string, string> = {
    layer: variable,
    layer2: variable,
    bbox: [p.lon - d, p.lat - d, p.lon + d, p.lat + d].map((n) => n.toFixed(4)).join(","),
    x: "1",
    y: "1",
    sizex: "3",
    sizey: "3",
    time: `${start}T00:00:00Z/${end}T00:00:00Z`,
  };
  let query = l.timeseries_url!.replace(/\$\{(\w+)\}/g, (m, k: string) => fill[k] ?? m);
  if (!/VERSION=/i.test(query)) query += "&VERSION=1.1.1";
  return `${l.url}${l.url.includes("?") ? "&" : "?"}${query}`;
}

// Data finer than 6-hourly is thinned to 00/06/12/18 UTC, as in the existing portal.
function thin(times: string[], values: (number | null)[]) {
  if (times.length < 2) return { times, values };
  const stepHours = (Date.parse(times[1]) - Date.parse(times[0])) / 36e5;
  if (stepHours >= 6) return { times, values };
  const keep = times.map((t, i) => (new Date(t).getUTCHours() % 6 === 0 ? i : -1)).filter((i) => i >= 0);
  return { times: keep.map((i) => times[i]), values: keep.map((i) => values[i]) };
}

type CoverageJson = {
  domain: { axes: { t: { values: string[] } } };
  ranges: Record<string, { values: (number | null)[] }>;
};

export async function fetchSeries(req: SeriesRequest, signal?: AbortSignal): Promise<Series[]> {
  const { layer, point, start, end } = req;
  const variables = split(layer.timeseries_variables);
  const labels = split(layer.timeseries_variable_label);
  // The legend describes the layer's first variable only, so other variables get no unit.
  const unit = unitOf(layer);

  return Promise.all(
    variables.map(async (variable, i) => {
      const res = await fetch(requestUrl(layer, variable, point, start, end), { signal });
      if (!res.ok) throw new Error(`${labels[i] ?? variable}: HTTP ${res.status}`);
      const data = (await res.json()) as CoverageJson;
      const key = variable.includes("/") ? variable.split("/")[1] : variable;
      const range = data.ranges[key] ?? Object.values(data.ranges)[0];
      const { times, values } = thin(data.domain.axes.t.values, range?.values ?? []);
      return { variable, label: labels[i] ?? variable, unit: i === 0 ? unit : "", times, values };
    }),
  );
}

export const isDirection = (label: string) => /\b(direction|dir|bearing|angle)\b/i.test(label);

export const formatPoint = (p: Point) => {
  const lon = ((((p.lon + 180) % 360) + 360) % 360) - 180; // display as -180..180
  return `${Math.abs(p.lat).toFixed(2)}°${p.lat < 0 ? "S" : "N"}, ${Math.abs(lon).toFixed(2)}°${lon < 0 ? "W" : "E"}`;
};
