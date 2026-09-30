// Every message is first routed through this schema: is it a data request, and if so,
// which dataset and what to do with it? The dataset choices come from the data tree via
// search (search.ts), so nothing here knows about particular datasets.

const nullable = (schema: object) => ({ anyOf: [schema, { type: "null" }] });
const date = { type: "string", pattern: "^[0-9]{4}-[0-9]{2}-[0-9]{2}$" };
export type QueryAction = "map" | "timeseries";

// `datasets` is this message's search shortlist: the model may only pick one of those ids,
// or null. The shortlist changes per message, so the schema is built per message.
export function querySchema(datasets: string[]) {
  return {
    type: "object",
    properties: {
      // First, so the model decides this before filling the other fields.
      intent: { type: "string", enum: ["data", "chat"] },
      dataset: datasets.length ? nullable({ type: "string", enum: datasets }) : { type: "null" },
      place: nullable({ type: "string" }),
      start: nullable(date),
      end: nullable(date),
    },
    required: ["intent", "dataset", "place", "start", "end"],
    additionalProperties: false,
  };
}

// What the model returns.
export type ModelQuery = {
  intent: "data" | "chat";
  dataset: string | null; // a data-tree dataset id from the shortlist
  place: string | null;
  start: string | null;
  end: string | null;
};

const today = () => new Date().toISOString().slice(0, 10);

// `options` are the shortlisted datasets as "id: title (details)" lines, best match first.
export const routerPrompt = (options: string[]) => `You route messages in an ocean data app.
Today is ${today()}.
Datasets that may match this message, best first (from the app's data catalog):
${options.length ? options.join("\n") : "(none)"}

intent: "data" if the user asks to plot, show, map or chart data; "chat" for greetings,
questions and explanations ("what is El Nino", "what data do you have").
dataset: the id of the option the user asks for, or null if none fits. When several fit and
the user didn't say which, pick the first.
place: a geographic place named in this message (e.g. "Fiji"), exactly as written, or null.
Never put a dataset name or id in place. start/end: dates the user gave, or null.
Use earlier messages for follow-ups like "same for Tonga" or "plot it".
For "chat", every other field is null. Reply with JSON only.

Examples:
"hi" -> {"intent":"chat","dataset":null,"place":null,"start":null,"end":null}
"what is El Nino" -> {"intent":"chat","dataset":null,"place":null,"start":null,"end":null}
"show me Fiji" -> {"intent":"data","dataset":null,"place":"Fiji","start":null,"end":null}`;

// Generic language cues, not dataset knowledge: verbs for showing data, and for charts over time.
const PLOT_WORDS = /\b(plot|map|show|display|draw|load|add|overlay|visuali[sz]e)\b/i;
const SERIES_WORDS = /\b(time ?series|over time|chart|graph|history|historical|timeline)\b/i;
// A follow-up that points back at the previous request ("plot it", "same for Tonga").
const REFERS_BACK = /\b(it|that|this|them|same|again|previous|last one)\b/i;
export const wantsPlot = (message: string) => PLOT_WORDS.test(message) || SERIES_WORDS.test(message);

// Whether every word of `text` appears in `message` (case-insensitive).
function mentioned(text: string, message: string) {
  const words = (s: string) => s.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 1);
  const said = new Set(words(message));
  const w = words(text);
  return w.length > 0 && w.every((x) => said.has(x));
}

export type Point = { lon: number; lat: number };

// Coordinates typed in the message: "18.1S 178.4E", "178.4E, 18.1S", or decimals like
// "-18.1, 178.4". A bare pair is read as lat, lon unless the first number can't be a latitude.
export function parsePoint(message: string): Point | null {
  const num = "(\\d{1,3}(?:\\.\\d+)?)\\s*°?\\s*";
  const latLon = new RegExp(`${num}([NS])[\\s,]+${num}([EW])`, "i").exec(message);
  if (latLon) return hemi(latLon[3], latLon[4], latLon[1], latLon[2]);
  const lonLat = new RegExp(`${num}([EW])[\\s,]+${num}([NS])`, "i").exec(message);
  if (lonLat) return hemi(lonLat[1], lonLat[2], lonLat[3], lonLat[4]);
  const pair = /(-?\d{1,3}\.\d+)\s*,\s*(-?\d{1,3}\.\d+)/.exec(message);
  if (!pair) return null;
  const [a, b] = [Number(pair[1]), Number(pair[2])];
  const [lat, lon] = Math.abs(a) > 90 ? [b, a] : [a, b];
  return Math.abs(lat) <= 90 && Math.abs(lon) <= 360 ? { lon, lat } : null;
}
function hemi(lon: string, ew: string, lat: string, ns: string): Point {
  return { lon: Number(lon) * (/w/i.test(ew) ? -1 : 1), lat: Number(lat) * (/s/i.test(ns) ? -1 : 1) };
}

// A routed request: the model's fields plus what code worked out from the message.
export type RoutedQuery = ModelQuery & { action: QueryAction; point: Point | null };

// Decides whether a message is a data request and which dataset it means. The dataset is
// the model's pick from the shortlist, else the best search hit, else, only when the
// message refers back or just changes the place, the previous request's dataset.
// Returns null for plain chat.
export function routeMessage(
  q: ModelQuery,
  message: string,
  last: RoutedQuery | null,
  shortlist: { id: string; label: string }[], // this message's dataset shortlist, best first
): RoutedQuery | null {
  const options = shortlist.map((o) => o.id);
  const chosen = q.dataset && options.includes(q.dataset) ? q.dataset : null;
  const point = parsePoint(message);
  // Small models put dataset names or "null" in place. Keep it only if the user wrote it,
  // and it isn't just the words of a dataset title (unless it's a known place).
  const echoesDataset = (p: string) => shortlist.some((o) => mentioned(p, o.label));
  const place =
    q.place && mentioned(q.place, message) && (resolvePlace(q.place) || !echoesDataset(q.place)) ? q.place : null;
  const knownPlace = !!(place && resolvePlace(place));
  const followUp = !options.length && !!last?.dataset && (REFERS_BACK.test(message) || knownPlace || !!point);
  const plot = wantsPlot(message);
  const isData =
    // The model said data: trust it only with evidence, since small models over-use "data".
    (q.intent === "data" && (!!chosen || !!options.length || followUp || knownPlace || !!point)) ||
    // The model said chat, but the user clearly asked to plot something we can identify.
    (q.intent === "chat" && plot && (!!options.length || followUp));
  if (!isData) return null;
  return {
    ...q,
    intent: "data",
    place,
    dataset: chosen ?? options[0] ?? (followUp ? last!.dataset : null),
    // Decided from the user's words, not the model: a chart only when they ask for one.
    action: SERIES_WORDS.test(message) ? "timeseries" : followUp ? last!.action : "map",
    point,
  };
}

// Facts the chat model can lean on; a 1.7B model gets these wrong without help.
const BACKGROUND = `Background (use it, don't recite it):
- El Nino: the eastern and central tropical Pacific warms; trade winds weaken. Typical Pacific impacts:
  drought risk in PNG, Solomon Islands, Vanuatu, Fiji, New Caledonia, Tonga and Samoa; wetter conditions
  in Kiribati and Tuvalu; more coral bleaching and shifts in tuna fisheries eastward.
- La Nina: the opposite; the eastern Pacific cools, the western Pacific warms, and rainfall patterns reverse.
- ENSO (El Nino-Southern Oscillation) cycles every 2 to 7 years and is tracked with the Nino 3.4 SST index.
- Sea level in the western tropical Pacific is rising faster than the global average.`;

export const chatPrompt = (dataOutline: string) => `You are a friendly assistant inside an ocean data app for Pacific Island countries.
Always reply in English. Answer from a Pacific Islands perspective.
Today is ${today()}.

Data in the app (a tree: kind of data > source > product group > dataset). Only these exist;
never invent others. "can:" lists what the app can do with each dataset.
${dataOutline || "- (the data catalog is still loading)"}

When the user asks to plot or map something, the app adds it to the map by itself;
place and date are optional (default: whole region, latest day), so never ask for them.
You cannot change the map yourself. Never say you are plotting, zooming, added, removed or changed a layer,
and never claim something "should appear". If the user can't see a layer, suggest they ask
again with the dataset's name from the list above.
Users can manage layers by typing e.g. "zoom to layer", "zoom to Fiji", "remove layer", "hide fiji",
"show it again" or "clear the map"; the app does these itself.
For a time series, users click a point on the map, or ask for "<dataset> time series near <place>".
You cannot see any data values yourself. If you are not sure of a fact, say so.
Keep replies to a few sentences.

${BACKGROUND}`;

// Place names are resolved here, not by the model. bbox = [west, south, east, north].
type BBox = [number, number, number, number];
const PLACES: Record<string, { bbox: BBox; aliases?: string[] }> = {
  fiji: { bbox: [176.5, -21.0, 181.0, -15.5] },
  tonga: { bbox: [184.0, -23.0, 187.5, -15.0] },
  samoa: { bbox: [187.0, -14.5, 189.5, -13.0] },
  vanuatu: { bbox: [166.0, -20.5, 170.5, -13.0] },
  "solomon islands": { bbox: [155.0, -12.5, 168.0, -5.0], aliases: ["solomons", "solomon"] },
  "papua new guinea": { bbox: [140.0, -12.0, 160.0, 0.0], aliases: ["png"] },
  "new caledonia": { bbox: [163.0, -23.0, 168.5, -19.5] },
  kiribati: { bbox: [168.0, -12.0, 211.0, 5.0] },
  tuvalu: { bbox: [175.5, -11.0, 180.0, -5.5] },
  "cook islands": { bbox: [194.0, -22.5, 203.0, -8.5], aliases: ["cooks"] },
  "gulf of mexico": { bbox: [-98.0, 18.0, -80.5, 31.0] },
};

export function resolvePlace(name: string) {
  const words = ` ${name.toLowerCase().replace(/[^a-z ]/g, " ").replace(/\s+/g, " ").trim()} `;
  // Whole-word match on the name or an alias, so "solomon" and "the Solomons" both work.
  const hit = Object.entries(PLACES).find(([key, p]) =>
    [key, ...(p.aliases ?? [])].some((n) => words.includes(` ${n} `)),
  );
  return hit ? { name: hit[0], bbox: hit[1].bbox } : null;
}

const DEFAULT_DAYS = 30;

// Fills defaults and resolves the place; `assumed` lists what the user didn't say.
export function finalizeQuery(q: ModelQuery | RoutedQuery) {
  const assumed: string[] = [];
  let end = q.end;
  let start = q.start;
  if (!end) {
    end = today();
    assumed.push("end = today");
  }
  if (!start) {
    const d = new Date(end);
    d.setDate(d.getDate() - DEFAULT_DAYS);
    start = d.toISOString().slice(0, 10);
    assumed.push(`start = ${DEFAULT_DAYS} days before end`);
  }
  if (start > end) [start, end] = [end, start];

  return {
    place: q.place ? resolvePlace(q.place) : null,
    placeText: q.place, // what the user wrote, kept to explain an unknown place
    start,
    end,
    action: "action" in q ? q.action : "map",
    point: "point" in q ? q.point : null,
    dataset: q.dataset,
    // Whether the user gave any dates; if not, a time series uses the full available range.
    userDates: !!(q.start || q.end),
    assumed,
  };
}
