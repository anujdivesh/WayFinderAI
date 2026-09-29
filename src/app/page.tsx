"use client";

import { useEffect, useState } from "react";
import ChatPanel from "./components/ChatPanel";
import MapView from "./components/MapView";
import Workbench from "./components/Workbench";
import { loadCatalog, type CatalogEntry } from "./catalog";
import { parseLayerCommand } from "./commands";
import { BASEMAPS, layerFromQuery, type BBox, type FinalQuery, type Layer } from "./layers";

export default function Home() {
  const [layers, setLayers] = useState<Layer[]>([]);
  const [catalog, setCatalog] = useState<CatalogEntry[]>([]);
  const [basemap, setBasemap] = useState(BASEMAPS[0].id);
  const [focus, setFocus] = useState<{ bbox: BBox; n: number } | null>(null);

  useEffect(() => {
    loadCatalog().then(setCatalog, (e) => console.warn("Catalog failed to load", e));
  }, []);

  const zoomTo = (bbox?: BBox) => bbox && setFocus((f) => ({ bbox, n: (f?.n ?? 0) + 1 }));

  function addLayer(layer: Layer) {
    setLayers((ls) => [layer, ...ls]); // newest on top
    zoomTo(layer.bbox);
  }

  function addQuery(query: FinalQuery) {
    const result = layerFromQuery(query, catalog);
    if (!result) return "Nothing to add to the map: no matching dataset and no known place.";
    addLayer(result.layer);
    return result.note;
  }

  // Layer commands typed in the chat; returns the reply, or null if it isn't a command.
  function runCommand(message: string) {
    const cmd = parseLayerCommand(message, layers);
    if (!cmd) return null;
    if (cmd.kind === "remove") setLayers((ls) => ls.filter((l) => !cmd.ids.includes(l.id)));
    if (cmd.kind === "hide" || cmd.kind === "show") {
      const visible = cmd.kind === "show";
      setLayers((ls) => ls.map((l) => (cmd.ids.includes(l.id) ? { ...l, visible } : l)));
    }
    return cmd.reply;
  }

  function move(id: string, dir: -1 | 1) {
    setLayers((ls) => {
      const i = ls.findIndex((l) => l.id === id);
      const j = i + dir;
      if (i < 0 || j < 0 || j >= ls.length) return ls;
      const next = [...ls];
      [next[i], next[j]] = [next[j], next[i]];
      return next;
    });
  }

  return (
    <>
      <MapView layers={layers} basemap={basemap} focus={focus} />
      <Workbench
        layers={layers}
        basemap={basemap}
        onBasemap={setBasemap}
        onChange={(id, patch) => setLayers((ls) => ls.map((l) => (l.id === id ? { ...l, ...patch } : l)))}
        onRemove={(id) => setLayers((ls) => ls.filter((l) => l.id !== id))}
        onZoom={(l) => zoomTo(l.bbox)}
        onMove={move}
      />
      <ChatPanel onQuery={addQuery} onCommand={runCommand} />
    </>
  );
}
