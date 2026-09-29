"use client";

import { useEffect, useRef } from "react";
import type { Map as MlMap, RasterTileSource } from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import { wmsTiles } from "../catalog";
import { BASEMAPS, type BBox, type Layer } from "../layers";
import styles from "../page.module.css";

type Props = {
  layers: Layer[];
  basemap: string;
  // Changing `n` re-triggers the fit even for the same bbox.
  focus: { bbox: BBox; n: number } | null;
};

const PREFIX = "wb-";
const styleFor = (id: string) => (BASEMAPS.find((b) => b.id === id) ?? BASEMAPS[0]).style;

const SUFFIXES = ["-fill", "-line", "-raster"];

// Makes the map's workbench layers match `layers`: adds, updates, removes and reorders.
function sync(map: MlMap, layers: Layer[]) {
  const wanted = new Set(layers.map((l) => PREFIX + l.id));
  for (const id of Object.keys(map.getStyle().sources ?? {})) {
    if (id.startsWith(PREFIX) && !wanted.has(id)) {
      for (const suffix of SUFFIXES) if (map.getLayer(id + suffix)) map.removeLayer(id + suffix);
      map.removeSource(id);
    }
  }
  // Workbench order is top-first, so add/move from the bottom up.
  for (const l of [...layers].reverse()) {
    const id = PREFIX + l.id;
    const visibility = l.visible ? "visible" : "none";

    if (l.wms) {
      const tiles = wmsTiles(l.wms.layer, l.wms.date);
      const source = map.getSource<RasterTileSource>(id);
      if (!source) {
        map.addSource(id, { type: "raster", tiles: [tiles], tileSize: 256, attribution: "SPC / NOAA OISST" });
        map.addLayer({ id: id + "-raster", type: "raster", source: id });
      } else if (source.tiles?.[0] !== tiles) {
        source.setTiles([tiles]); // date changed
      }
      map.setLayoutProperty(id + "-raster", "visibility", visibility);
      map.setPaintProperty(id + "-raster", "raster-opacity", l.opacity);
      map.moveLayer(id + "-raster");
      continue;
    }

    if (!l.bbox) continue;
    const [w, s, e, n] = l.bbox;
    if (!map.getSource(id)) {
      map.addSource(id, {
        type: "geojson",
        data: {
          type: "Feature",
          properties: {},
          geometry: { type: "Polygon", coordinates: [[[w, s], [e, s], [e, n], [w, n], [w, s]]] },
        },
      });
      map.addLayer({ id: id + "-fill", type: "fill", source: id, paint: { "fill-color": l.color } });
      map.addLayer({ id: id + "-line", type: "line", source: id, paint: { "line-color": l.color, "line-width": 2 } });
    }
    map.setLayoutProperty(id + "-fill", "visibility", visibility);
    map.setLayoutProperty(id + "-line", "visibility", visibility);
    map.setPaintProperty(id + "-fill", "fill-opacity", l.opacity);
    map.setPaintProperty(id + "-line", "line-opacity", Math.min(1, l.opacity * 2.5));
    map.moveLayer(id + "-fill");
    map.moveLayer(id + "-line");
  }
}

export default function MapView({ layers, basemap, focus }: Props) {
  const container = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<MlMap | null>(null);
  const layersRef = useRef(layers);
  const basemapRef = useRef(basemap);

  // Create the map once. maplibre-gl touches `window`, so load it on the client only.
  useEffect(() => {
    let map: MlMap | undefined;
    let cancelled = false;
    import("maplibre-gl").then((maplibregl) => {
      if (cancelled || !container.current) return;
      // Bundling breaks MapLibre's default worker path; serve it from public/ instead
      // (copied there by scripts/copy-assets.mjs).
      maplibregl.setWorkerUrl(new URL("/maplibre/maplibre-gl-worker.mjs", location.origin).href);
      const m = new maplibregl.Map({
        container: container.current,
        style: styleFor(basemapRef.current),
        center: [175, -15], // western/central tropical Pacific
        zoom: 3,
        renderWorldCopies: true,
      });
      m.addControl(new maplibregl.NavigationControl(), "top-right");
      m.addControl(new maplibregl.ScaleControl(), "bottom-left");
      // A basemap change replaces the whole style, so re-add workbench layers each time.
      m.on("style.load", () => sync(m, layersRef.current));
      map = mapRef.current = m;
    });
    return () => {
      cancelled = true;
      map?.remove();
      mapRef.current = null;
    };
  }, []);

  useEffect(() => {
    layersRef.current = layers;
    const map = mapRef.current;
    if (map?.isStyleLoaded()) sync(map, layers);
  }, [layers]);

  useEffect(() => {
    if (basemapRef.current === basemap) return;
    basemapRef.current = basemap;
    mapRef.current?.setStyle(styleFor(basemap));
  }, [basemap]);

  useEffect(() => {
    if (!focus) return;
    const [w, s, e, n] = focus.bbox;
    mapRef.current?.fitBounds(
      [
        [w, s],
        [e, n],
      ],
      // Leave room for the workbench (left) and the chat (bottom right).
      { padding: { top: 60, bottom: 60, left: 340, right: 420 }, maxZoom: 7, duration: 1200 },
    );
  }, [focus]);

  // MapLibre sets `position: relative` on its container, so it gets an inner div that
  // fills a fixed wrapper; otherwise the map can collapse to zero height.
  return (
    <div className={styles.map}>
      <div ref={container} className={styles.mapCanvas} />
    </div>
  );
}
