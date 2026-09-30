import type { BBox, Layer } from "./layers";
import { resolvePlace } from "./query";

// Layer management typed into the chat ("remove layer", "hide fiji", "clear the map").
// Handled in code, not by the model: it's instant, and a small model would only
// claim to have done it.
export type LayerCommand =
  | { kind: "remove" | "hide" | "show"; ids: string[]; reply: string }
  | { kind: "zoom"; bbox: BBox; reply: string }
  | { kind: "none"; reply: string }; // understood, but nothing to act on

const VERBS: [LayerCommand["kind"], RegExp][] = [
  ["zoom", /\b(zoom|fly|pan|go|take me)\b.*\b(to|in|into|on|over)\b|\bzoom\b/i],
  ["remove", /\b(remove|delete|drop|clear|reset|get rid of)\b/i],
  ["hide", /\b(hide|turn off|switch off)\b/i],
  // "show X" / "show it on the map" are data requests; only "show ... again/back" is a command.
  ["show", /\b(unhide|turn on|switch on)\b|\bshow\b.*\b(again|back)\b/i],
];
// "all layers", or "clear/reset the map"; a bare "the map" ("remove fiji from the map") isn't "all".
const ALL = /\b(all|everything|every layer)\b|\b(clear|reset)\b.*\bmap\b/i;
const STOP = new Set(["the", "a", "an", "layer", "layers", "it", "that", "this", "on", "of", "for", "map", "please"]);

const words = (s: string) =>
  s
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length > 2 && !STOP.has(w));

// Words a layer can be referred to by: its title and place.
function layerWords(l: Layer) {
  return new Set(words([l.title, l.subtitle, l.query?.place?.name].join(" ")));
}

export function parseLayerCommand(message: string, layers: Layer[]): LayerCommand | null {
  const verb = VERBS.find(([, re]) => re.test(message));
  if (!verb) return null;
  const kind = verb[0] as "remove" | "hide" | "show" | "zoom";
  const named = layers.filter((l) => {
    const lw = layerWords(l);
    return words(message).some((w) => lw.has(w));
  });

  // "zoom to Fiji": a place, when no layer is named.
  if (kind === "zoom" && !named.length) {
    const place = resolvePlace(message);
    if (place) return { kind: "zoom", bbox: place.bbox, reply: `Zoomed to ${place.name.replace(/\b\w/g, (c) => c.toUpperCase())}.` };
  }
  if (!layers.length) return { kind: "none", reply: "There are no layers on the map." };

  if (kind === "zoom") {
    const target = named[0] ?? layers[0];
    const bbox = target.bbox ?? target.extent;
    return bbox
      ? { kind: "zoom", bbox, reply: `Zoomed to ${target.title}.` }
      : { kind: "none", reply: `${target.title} has no extent to zoom to yet.` };
  }

  // Target: every layer, the layers the message names, or else the newest one.
  let targets: Layer[];
  if (ALL.test(message)) {
    targets = layers;
  } else {
    targets = named;
    // Nothing named: "show it again" means the hidden layers, anything else the newest layer.
    const hidden = layers.filter((l) => !l.visible);
    if (!targets.length) targets = kind === "show" && hidden.length ? hidden : [layers[0]];
  }

  const names = targets.map((l) => (l.query?.place ? `${l.title} (${l.query.place.name})` : l.title));
  const list = names.length > 3 ? `${names.length} layers` : names.join(", ");
  const done = { remove: "Removed", hide: "Hid", show: "Showing" }[kind];
  return { kind, ids: targets.map((l) => l.id), reply: `${done} ${list}.` };
}
