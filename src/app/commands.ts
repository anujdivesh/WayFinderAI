import type { Layer } from "./layers";

// Layer management typed into the chat ("remove layer", "hide fiji", "clear the map").
// Handled in code, not by the model: it's instant, and a small model would only
// claim to have done it.
export type LayerCommand =
  | { kind: "remove" | "hide" | "show"; ids: string[]; reply: string }
  | { kind: "none"; reply: string }; // understood, but nothing to act on

const VERBS: [LayerCommand["kind"], RegExp][] = [
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

// Words a layer can be referred to by: its title, place and variable.
function layerWords(l: Layer) {
  return new Set(words([l.title, l.subtitle, l.query?.place?.name, l.query?.variable?.replace("_", " ")].join(" ")));
}

export function parseLayerCommand(message: string, layers: Layer[]): LayerCommand | null {
  const verb = VERBS.find(([, re]) => re.test(message));
  if (!verb) return null;
  const kind = verb[0] as "remove" | "hide" | "show";
  if (!layers.length) return { kind: "none", reply: "There are no layers on the map." };

  // Target: every layer, the layers the message names, or else the newest one.
  let targets: Layer[];
  if (ALL.test(message)) {
    targets = layers;
  } else {
    const asked = words(message);
    targets = layers.filter((l) => {
      const lw = layerWords(l);
      return asked.some((w) => lw.has(w));
    });
    // Nothing named: "show it again" means the hidden layers, anything else the newest layer.
    const hidden = layers.filter((l) => !l.visible);
    if (!targets.length) targets = kind === "show" && hidden.length ? hidden : [layers[0]];
  }

  const names = targets.map((l) => (l.query?.place ? `${l.title} (${l.query.place.name})` : l.title));
  const list = names.length > 3 ? `${names.length} layers` : names.join(", ");
  const done = { remove: "Removed", hide: "Hid", show: "Showing" }[kind];
  return { kind, ids: targets.map((l) => l.id), reply: `${done} ${list}.` };
}
