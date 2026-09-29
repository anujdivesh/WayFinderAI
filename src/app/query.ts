// Every message is first routed through this schema: is it a data request, and if so,
// what query? Anything the user didn't say is null; defaults are applied in code.
export const VARIABLES = ["sst", "sst_anomaly", "salinity", "chlorophyll", "wave_height", "sea_level"] as const;
const AGGREGATIONS = ["none", "mean", "max", "min"] as const;

const nullable = (schema: object) => ({ anyOf: [schema, { type: "null" }] });
const date = { type: "string", pattern: "^[0-9]{4}-[0-9]{2}-[0-9]{2}$" };

export const querySchema = {
  type: "object",
  properties: {
    // First, so the model decides this before filling the other fields.
    intent: { type: "string", enum: ["data", "chat"] },
    variable: nullable({ type: "string", enum: VARIABLES }),
    place: nullable({ type: "string" }),
    start: nullable(date),
    end: nullable(date),
    aggregation: nullable({ type: "string", enum: AGGREGATIONS }),
  },
  required: ["intent", "variable", "place", "start", "end", "aggregation"],
  additionalProperties: false,
};

// What the model returns.
export type ModelQuery = {
  intent: "data" | "chat";
  variable: (typeof VARIABLES)[number] | null;
  place: string | null;
  start: string | null;
  end: string | null;
  aggregation: (typeof AGGREGATIONS)[number] | null;
};

const today = () => new Date().toISOString().slice(0, 10);

export const routerPrompt = () => `You classify messages for an ocean data app and extract a query.
Today is ${today()}.
intent is "data" only if the user asks to get, show or map ocean data for a place. Otherwise "chat".
Questions about concepts ("what is El Nino", "explain in the Pacific context") are "chat".
Variables: sst = sea surface temperature, sst_anomaly = SST anomaly (warmer/cooler than normal,
also marine heatwaves), salinity, chlorophyll, wave_height, sea_level.
place: the place name as the user wrote it. Use earlier messages for follow-ups like "same for Tonga".
Use null for anything the user did not state. Do not guess. For "chat", every other field is null.

Examples:
"hi" -> {"intent":"chat","variable":null,"place":null,"start":null,"end":null,"aggregation":null}
"what is El Nino" -> {"intent":"chat","variable":null,"place":null,"start":null,"end":null,"aggregation":null}
"in the pacific context" -> {"intent":"chat","variable":null,"place":null,"start":null,"end":null,"aggregation":null}
"show me Fiji" -> {"intent":"data","variable":null,"place":"Fiji","start":null,"end":null,"aggregation":null}
"average SST near Samoa in March 2025" -> {"intent":"data","variable":"sst","place":"Samoa","start":"2025-03-01","end":"2025-03-31","aggregation":"mean"}
"show sst anomaly" -> {"intent":"data","variable":"sst_anomaly","place":null,"start":null,"end":null,"aggregation":null}
Reply with JSON only.`;

// Variables named in the message, checked in order (anomaly before plain SST).
// Code is more reliable at this than a small model, which sometimes invents a variable.
const VARIABLE_PATTERNS: [ModelQuery["variable"] & string, RegExp][] = [
  ["sst_anomaly", /\b(anomaly|anomalies|heat ?waves?)\b/i],
  ["sst", /\b(sst|sea surface temp\w*|sea temp\w*|temperature|temp)\b/i],
  ["salinity", /\b(salinity|salt|sss)\b/i],
  ["chlorophyll", /\b(chlorophyll|chl)\b/i],
  ["wave_height", /\b(waves?|swell)\b/i],
  ["sea_level", /\bsea ?level\b/i],
];
const variableIn = (message: string) => VARIABLE_PATTERNS.find(([, re]) => re.test(message))?.[0] ?? null;
const PLOT_WORDS = /\b(plot|map|show|display|draw|load|add|overlay|visuali[sz]e)\b/i;

// Decides whether a message is a data request, and fills gaps from the previous request
// so follow-ups like "plot it" or "same for Tonga" work. Returns null for plain chat.
export function routeMessage(q: ModelQuery, message: string, last: ModelQuery | null): ModelQuery | null {
  const named = variableIn(message);
  const knownPlace = !!(q.place && resolvePlace(q.place));
  const wantsPlot = PLOT_WORDS.test(message);
  const carried = last?.variable ?? null;
  const isData =
    // The model said data: trust it only with evidence, since it over-uses "data".
    (q.intent === "data" && (knownPlace || !!named || (wantsPlot && !!carried))) ||
    // The model said chat, but the user clearly asked to plot something.
    (q.intent === "chat" && wantsPlot && (!!named || !!carried));
  if (!isData) return null;
  return { ...q, intent: "data", variable: named ?? carried ?? q.variable };
}

// Facts the chat model can lean on; a 1.7B model gets these wrong without help.
const BACKGROUND = `Background (use it, don't recite it):
- El Nino: the eastern and central tropical Pacific warms; trade winds weaken. Typical Pacific impacts:
  drought risk in PNG, Solomon Islands, Vanuatu, Fiji, New Caledonia, Tonga and Samoa; wetter conditions
  in Kiribati and Tuvalu; more coral bleaching and shifts in tuna fisheries eastward.
- La Nina: the opposite; the eastern Pacific cools, the western Pacific warms, and rainfall patterns reverse.
- ENSO (El Nino-Southern Oscillation) cycles every 2 to 7 years and is tracked with the Nino 3.4 SST index.
- Sea level in the western tropical Pacific is rising faster than the global average.`;

export const chatPrompt = () => `You are a friendly assistant inside an ocean data app for Pacific Island countries.
Always reply in English. Answer from a Pacific Islands perspective.
Today is ${today()}.
The app can map sea surface temperature anomalies (daily, from SPC's THREDDS server).
When the user asks to plot or map something, the app adds it to the map by itself;
place and date are optional (default: whole region, latest day), so never ask for them.
You cannot change the map yourself. Never say you added, removed or changed a layer.
Users can manage layers by typing e.g. "remove layer", "hide fiji", "show it again" or "clear the map".
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
export function finalizeQuery(q: ModelQuery) {
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
  if (!q.aggregation) assumed.push('aggregation = "none"');

  return {
    variable: q.variable,
    place: q.place ? resolvePlace(q.place) : null,
    placeText: q.place, // what the user wrote, kept to explain an unknown place
    start,
    end,
    aggregation: q.aggregation ?? "none",
    assumed,
  };
}
