"use client";

import { useState } from "react";
import ChartPanel from "./components/ChartPanel";
import ChatPanel from "./components/ChatPanel";
import MapView from "./components/MapView";
import Workbench from "./components/Workbench";
import { probeWms } from "./catalog";
import { parseLayerCommand } from "./commands";
import { dataOutline } from "./datatree";
import { canChart, canChartStations, layerFromQuery, nextColor, type BBox, type FinalQuery, type Layer } from "./layers";
import { extentOf, fetchPoints, nearestStation, stationChart, type StationPoint } from "./points";
import { shortlist } from "./search";
import { formatPoint, gridChart, seriesRange, type ChartRequest, type Point } from "./timeseries";

const centre = ([w, s, e, n]: BBox): Point => ({ lon: (w + e) / 2, lat: (s + n) / 2 });

// Which dataset a layer shows: the middleware layer behind it, or the region for outlines.
const datasetKey = (l: Layer) =>
  l.wms ? `wms:${l.wms.layer.id}` : l.points ? `points:${l.points.layer.id}` : `region:${l.title}`;

// A gridded layer's time series at `point`: its requested dates, or the full available range.
function seriesFor(layer: Layer, point: Point, pointLabel?: string): ChartRequest | null {
  if (!layer.wms || !canChart(layer)) return null;
  const q = layer.query;
  const dates = q?.userDates ? seriesRange(layer.wms.layer, q.start, q.end) : seriesRange(layer.wms.layer);
  return gridChart({ layer: layer.wms.layer, point, pointLabel, ...dates });
}

// Built once from the synced snapshot (src/data/layers.json); nothing is fetched at runtime.
const DATA_OUTLINE = dataOutline();

export default function Home() {
  const [layers, setLayers] = useState<Layer[]>([]);
  const [focus, setFocus] = useState<{ bbox: BBox; n: number } | null>(null);
  const [series, setSeries] = useState<ChartRequest | null>(null);

  const zoomTo = (bbox?: BBox) => bbox && setFocus((f) => ({ bbox, n: (f?.n ?? 0) + 1 }));

  function addLayer(layer: Layer) {
    setLayers((ls) => [layer, ...ls]); // newest on top
    zoomTo(layer.bbox);
  }

  const patchLayer = (id: string, patch: Partial<Layer>) =>
    setLayers((ls) => ls.map((l) => (l.id === id ? { ...l, ...patch } : l)));

  // Point layers: fetch the stations after adding, then zoom to them (unless a place was named).
  async function loadStations(layer: Layer): Promise<{ stations: StationPoint[]; note: string }> {
    const p = layer.points!;
    try {
      const stations = await fetchPoints(p.layer);
      const bbox = layer.bbox ?? extentOf(stations);
      patchLayer(layer.id, { points: { ...p, stations }, extent: extentOf(stations) ?? layer.extent, subtitle: `${stations.length} stations` });
      if (!layer.bbox) zoomTo(bbox);
      const tip = canChartStations(layer) ? " Click a station for its time series." : "";
      return { stations, note: `${stations.length} stations.${tip}` };
    } catch (e) {
      patchLayer(layer.id, { points: { ...p, stations: [], error: String(e) }, subtitle: "Couldn't load stations" });
      return { stations: [], note: `The stations couldn't be loaded (${String(e)}).` };
    }
  }

  async function addQuery(query: FinalQuery): Promise<string> {
    const result = layerFromQuery(query, nextColor(layers.map((l) => l.color)));
    if (!result) return "Nothing to add to the map: no matching dataset and no known place.";

    // One layer per dataset: asking again (another date, another place, "I can't see it")
    // updates the layer that's already there instead of stacking a copy.
    const existing = layers.find((l) => datasetKey(l) === datasetKey(result.layer));

    // Gridded data: check the server can draw that date before saying anything was added.
    if (result.layer.wms) {
      const date = existing?.wms && !query.userDates ? existing.wms.date : result.layer.wms.date;
      const problem = await probeWms(result.layer.wms.layer, date);
      if (problem) return `I couldn't get ${result.layer.title} for ${date}: ${problem}. Nothing was added.`;
    }

    let layer = result.layer;
    let note = result.note;
    let stations = existing?.points?.stations ?? [];
    if (existing) {
      const newDate = query.userDates && result.layer.wms ? result.layer.wms.date : existing.wms?.date;
      layer = {
        ...existing,
        visible: true,
        query,
        bbox: query.place ? result.layer.bbox : existing.bbox,
        ...(existing.wms && newDate ? { wms: { ...existing.wms, date: newDate } } : {}),
      };
      setLayers((ls) => [layer, ...ls.filter((l) => l.id !== existing.id)]);
      zoomTo(layer.bbox ?? layer.extent);
      note =
        existing.wms && newDate !== existing.wms.date
          ? `${existing.title} is already on the map; I've changed it to ${newDate}.`
          : `${existing.title} is already on the map; I've made it visible and moved it to the top.`;
    } else {
      addLayer(layer);
      if (layer.points) {
        const loaded = await loadStations(layer);
        stations = loaded.stations;
        note = `${note} ${loaded.note}`;
      }
    }

    if (query.action !== "timeseries") return note;

    // Time series: typed coordinates, else the centre of the named place, else wait for a click.
    const point = query.point ?? (query.place ? centre(query.place.bbox) : null);

    // Point data: the station nearest the requested point.
    if (layer.points) {
      if (!canChartStations(layer)) return `${note} ${layer.title} has no per-station time series.`;
      if (!point) return `${note} Click a station to see its time series.`;
      const station = nearestStation(stations, point);
      if (!station) return note;
      setSeries(stationChart(layer.points.layer, station));
      return `${note} Showing ${station.name}, the nearest station. Click another station to change it.`;
    }

    if (!layer.wms || !canChart(layer)) {
      return `${note} ${layer.title} can only be mapped; it has no time series.`;
    }
    if (!point) return `${note} Click a point on the map to see its time series.`;
    const where = query.point ? undefined : `Centre of ${query.place!.name.replace(/\b\w/g, (c) => c.toUpperCase())}`;
    const req = seriesFor(layer, point, where)!;
    setSeries(req);
    return (
      `Showing the ${layer.title} time series at ${formatPoint(point)}${where ? ` (${where.toLowerCase()})` : ""}. ` +
      `Click anywhere on the map to change the point.`
    );
  }

  // A station click charts that station, or says why it can't (and which layer can).
  function onStationClick(layerId: string, index: number) {
    const layer = layers.find((l) => l.id === layerId);
    const station = layer?.points?.stations?.[index];
    if (!layer?.points || !station) return;
    if (canChartStations(layer)) return setSeries(stationChart(layer.points.layer, station));
    const alt = shortlist(layer.title).find(
      (d) => d.kind === "point" && d.actions.includes("timeseries") && d.layer.id !== layer.points!.layer.id,
    );
    setSeries({
      title: station.name,
      subtitle: `${layer.title} · ${formatPoint(station)}`,
      point: station,
      load: async () => [],
      empty: `${layer.title} has no per-station time series.${alt ? ` Try "plot ${alt.label}", whose stations can be charted.` : ""}`,
    });
  }

  // A map click charts the top visible gridded layer that supports time series.
  function onMapClick(point: Point) {
    const layer = layers.find((l) => l.visible && canChart(l));
    if (layer) setSeries(seriesFor(layer, point));
  }

  // Layer commands typed in the chat; returns the reply, or null if it isn't a command.
  function runCommand(message: string) {
    const cmd = parseLayerCommand(message, layers);
    if (!cmd) return null;
    if (cmd.kind === "zoom") zoomTo(cmd.bbox);
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
      <MapView
        layers={layers}
        focus={focus}
        marker={series?.point ?? null}
        onMapClick={onMapClick}
        onStationClick={onStationClick}
      />
      <Workbench
        layers={layers}
        onChange={patchLayer}
        onRemove={(id) => setLayers((ls) => ls.filter((l) => l.id !== id))}
        onZoom={(l) => zoomTo(l.bbox ?? l.extent)}
        onMove={move}
      />
      <ChartPanel request={series} onClose={() => setSeries(null)} />
      <ChatPanel onQuery={addQuery} onCommand={runCommand} dataOutline={DATA_OUTLINE} />
    </>
  );
}
