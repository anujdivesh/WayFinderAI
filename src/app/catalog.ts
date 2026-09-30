// Low-level helpers for one SPC middleware layer (the JSON from /layer_web_map/<id>/).
// Which layers exist and what they're for lives in datatree.ts.

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
  // Point time series via ncWMS GetTimeseries; the URL is a query-string template.
  enable_chart_timeseries: boolean;
  timeseries_url: string | null;
  timeseries_variables: string | null; // comma-separated
  timeseries_variable_label: string | null; // comma-separated, same order
};

// Layers whose legend URL has a wrong unit (as of the 2026-09-29 snapshot): alerts,
// categories and deciles have none, and the trend layers aren't in mm. Blank beats wrong;
// fix the unit= parameter in the middleware and drop the id from this list.
const BAD_LEGEND_UNIT = new Set([4, 19, 30, 37, 47, 57, 58, 59, 61, 62, 63, 64]);

// The legend URL carries the unit (…&unit=%C2%B0C); the middleware has no separate field.
export function unitOf(l: SpcLayer) {
  if (BAD_LEGEND_UNIT.has(l.id)) return "";
  try {
    const unit = new URL(l.legend_url).searchParams.get("unit") ?? "";
    return unit === "-" ? "" : unit;
  } catch {
    return "";
  }
}

const day = (iso: string) => iso.slice(0, 10);
export const timeRange = (l: SpcLayer) => ({ min: day(l.timeIntervalStart), max: day(l.timeIntervalEnd) });

// Keeps a requested date inside what the server has.
export function clampDate(l: SpcLayer, date: string) {
  const { min, max } = timeRange(l);
  return date < min ? min : date > max ? max : date;
}

// ncWMS GetMap settings for Cesium's WebMapServiceImageryProvider. WMS 1.1.1 with
// EPSG:4326 keeps the BBOX in lon,lat order (1.3.0 flips it to lat,lon).
export function wmsOptions(l: SpcLayer, date: string) {
  return {
    url: l.url,
    layers: l.layer_name,
    parameters: {
      version: "1.1.1",
      styles: l.style,
      format: l.image_format,
      transparent: String(l.transparent),
      colorscalerange: `${l.colormin},${l.colormax}`,
      numcolorbands: String(l.numcolorbands),
      abovemaxcolor: l.abovemaxcolor,
      belowmincolor: l.belowmincolor,
      logscale: String(l.logscale),
      time: `${date}T00:00:00Z`,
    },
  };
}

// Gridded layers with a point time series: the layer has it switched on, and its template
// is an ncWMS query string. Point layers (SOFAR, WFS tides) use absolute URLs to other APIs.
export const supportsTimeseries = (l: SpcLayer) =>
  l.enable_chart_timeseries &&
  !!l.timeseries_url &&
  !!l.timeseries_variables &&
  !/^https?:/.test(l.timeseries_url) &&
  l.layer_type.startsWith("WMS");
