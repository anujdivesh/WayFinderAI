"use client";

import { useEffect, useRef } from "react";
import type * as CesiumNS from "cesium";
import { asset } from "../asset";
import { wmsOptions } from "../catalog";
import type { BBox, Layer } from "../layers";
import { lon360 } from "../points";
import type { Point } from "../timeseries";
import styles from "../page.module.css";

type Cesium = typeof CesiumNS;

type Props = {
  layers: Layer[];
  // Changing `n` re-triggers the fly-to even for the same bbox.
  focus: { bbox: BBox; n: number } | null;
  // Where the current time series is from (a pin on the globe), and clicks to pick a new point.
  marker: Point | null;
  onMapClick: (p: Point) => void;
  // A click on a station dot: its layer and index in that layer's stations.
  onStationClick: (layerId: string, index: number) => void;
};

// What we've put on the globe for one workbench layer.
type Handle = {
  imagery?: CesiumNS.ImageryLayer;
  imageryKey?: string;
  entity?: CesiumNS.Entity;
  stations?: CesiumNS.CustomDataSource;
  stationsKey?: string;
};

// Station dots and the time-series pin sit a little above sea level and keep Cesium's normal
// depth test, so the globe hides them when they're on its far side (while never sinking
// into the surface on this side).
const MARKER_HEIGHT = 2_000; // metres
const STATION_ID = "station:"; // entity id prefix: station:<layer id>#<index>

// Cesium wants longitudes in -180..180; place boxes use 176..181 etc. to cross the antimeridian.
const lon180 = (lon: number) => ((((lon + 180) % 360) + 360) % 360) - 180;
const rect = (C: Cesium, [w, s, e, n]: BBox) => C.Rectangle.fromDegrees(lon180(w), s, lon180(e), n);

// Makes the globe match `layers`: adds, updates, removes and reorders.
function sync(C: Cesium, viewer: CesiumNS.Viewer, layers: Layer[], handles: Map<string, Handle>) {
  const wanted = new Set(layers.map((l) => l.id));
  for (const [id, h] of handles) {
    if (wanted.has(id)) continue;
    if (h.imagery) viewer.imageryLayers.remove(h.imagery, true);
    if (h.entity) viewer.entities.remove(h.entity);
    if (h.stations) viewer.dataSources.remove(h.stations, true);
    handles.delete(id);
  }

  for (const l of layers) {
    const h = handles.get(l.id) ?? {};
    handles.set(l.id, h);

    if (l.wms) {
      // Imagery providers are immutable, so a new date means a new imagery layer.
      const key = `${l.wms.layer.id}|${l.wms.date}`;
      if (h.imageryKey !== key) {
        if (h.imagery) viewer.imageryLayers.remove(h.imagery, true);
        h.imagery = viewer.imageryLayers.addImageryProvider(
          new C.WebMapServiceImageryProvider({ ...wmsOptions(l.wms.layer, l.wms.date), tileWidth: 256, tileHeight: 256 }),
        );
        h.imageryKey = key;
      }
      h.imagery!.alpha = l.opacity;
      h.imagery!.show = l.visible;
      continue;
    }

    if (l.points) {
      // One data source per point layer: a dot per station, the name shown on hover.
      const color = C.Color.fromCssColorString(l.color);
      const key = `${l.points.stations?.length ?? "loading"}|${l.color}|${l.opacity}`;
      if (!h.stations) {
        h.stations = new C.CustomDataSource(l.id);
        void viewer.dataSources.add(h.stations);
      }
      if (h.stationsKey !== key) {
        h.stations.entities.removeAll();
        for (const [i, p] of (l.points.stations ?? []).entries()) {
          h.stations.entities.add({
            id: `${STATION_ID}${l.id}#${i}`, // read back on click
            position: C.Cartesian3.fromDegrees(p.lon, p.lat, MARKER_HEIGHT),
            point: {
              pixelSize: 8,
              color: color.withAlpha((p.active ? 1 : 0.35) * l.opacity),
              outlineColor: C.Color.WHITE.withAlpha(l.opacity),
              outlineWidth: 1.5,
            },
            label: {
              text: p.active ? p.name : `${p.name} (inactive)`,
              show: false, // shown on hover
              font: "13px sans-serif",
              fillColor: C.Color.WHITE,
              outlineColor: C.Color.BLACK,
              outlineWidth: 3,
              style: C.LabelStyle.FILL_AND_OUTLINE,
              pixelOffset: new C.Cartesian2(0, -14),
            },
          });
        }
        h.stationsKey = key;
      }
      h.stations.show = l.visible;
      continue;
    }

    if (!l.bbox) continue;
    const color = C.Color.fromCssColorString(l.color);
    if (!h.entity) {
      h.entity = viewer.entities.add({
        rectangle: { coordinates: rect(C, l.bbox), height: 0, outline: true, outlineWidth: 2 },
      });
    }
    h.entity.show = l.visible;
    h.entity.rectangle!.material = new C.ColorMaterialProperty(color.withAlpha(l.opacity));
    h.entity.rectangle!.outlineColor = new C.ConstantProperty(color.withAlpha(Math.min(1, l.opacity * 2.5)));
  }

  // Workbench order is top-first; the basemap stays at the bottom.
  for (const l of [...layers].reverse()) {
    const imagery = handles.get(l.id)?.imagery;
    if (imagery) viewer.imageryLayers.raiseToTop(imagery);
  }
  viewer.scene.requestRender();
}

export default function MapView({ layers, focus, marker, onMapClick, onStationClick }: Props) {
  const container = useRef<HTMLDivElement | null>(null);
  const ref = useRef<{ C: Cesium; viewer: CesiumNS.Viewer; handles: Map<string, Handle>; pin: CesiumNS.Entity } | null>(
    null,
  );
  const layersRef = useRef(layers);
  const markerRef = useRef(marker);
  const clickRef = useRef(onMapClick);
  const stationClickRef = useRef(onStationClick);
  useEffect(() => {
    clickRef.current = onMapClick;
    stationClickRef.current = onStationClick;
  }, [onMapClick, onStationClick]);

  // Create the viewer once. Cesium touches `window`, so load it on the client only.
  useEffect(() => {
    let cancelled = false;
    let viewer: CesiumNS.Viewer | undefined;
    // Workers, widget assets and CSS are served from public/cesium (scripts/copy-assets.mjs).
    (window as Window & { CESIUM_BASE_URL?: string }).CESIUM_BASE_URL = asset("/cesium");

    import("cesium").then((C) => {
      if (cancelled || !container.current) return;
      const token = process.env.NEXT_PUBLIC_CESIUM_ION_TOKEN;
      if (token) C.Ion.defaultAccessToken = token;
      else console.warn("NEXT_PUBLIC_CESIUM_ION_TOKEN is not set; using the Esri Ocean basemap instead.");

      const v = new C.Viewer(container.current, {
        // Cesium ion's default imagery (Bing Maps aerial) when there is a token.
        baseLayer: token
          ? C.ImageryLayer.fromWorldImagery({})
          : new C.ImageryLayer(
              new C.UrlTemplateImageryProvider({
                url: "https://server.arcgisonline.com/ArcGIS/rest/services/Ocean/World_Ocean_Base/MapServer/tile/{z}/{y}/{x}",
                credit: "Esri, GEBCO, NOAA, National Geographic, Garmin, HERE, Geonames.org, and other contributors",
                maximumLevel: 10,
              }),
            ),
        animation: false,
        timeline: false,
        baseLayerPicker: false,
        geocoder: false,
        homeButton: false,
        sceneModePicker: true, // 3D globe / 2D map / Columbus view
        navigationHelpButton: false,
        fullscreenButton: false,
        infoBox: false,
        selectionIndicator: false,
        // Only redraw when something changes: the chat model shares the GPU.
        requestRenderMode: true,
        maximumRenderTimeChange: Infinity,
      });
      viewer = v;
      // Show data layers in their true colours: ground atmosphere and fog tint the surface
      // (a white haze from afar), which washes out WMS colour scales against their legends.
      // The glow around the globe's edge (sky atmosphere) stays; it doesn't cover the data.
      v.scene.globe.showGroundAtmosphere = false;
      v.scene.globe.enableLighting = false;
      v.scene.fog.enabled = false;
      // Cesium's own entity handling: a click selects an entity and a double-click *tracks* it,
      // locking the camera to the point so the map moves with it. The app handles clicks itself.
      const builtIn = v.cesiumWidget.screenSpaceEventHandler;
      builtIn.removeInputAction(C.ScreenSpaceEventType.LEFT_CLICK);
      builtIn.removeInputAction(C.ScreenSpaceEventType.LEFT_DOUBLE_CLICK);
      v.camera.setView({ destination: C.Cartesian3.fromDegrees(175, -15, 12_000_000) }); // tropical Pacific

      const pin = v.entities.add({
        show: false,
        point: {
          pixelSize: 12,
          color: C.Color.fromCssColorString("#0e7490"),
          outlineColor: C.Color.WHITE,
          outlineWidth: 2,
        },
      });

      const handler = new C.ScreenSpaceEventHandler(v.scene.canvas);
      handler.setInputAction((e: { position: CesiumNS.Cartesian2 }) => {
        // A station dot: chart that station.
        const picked = v.scene.pick(e.position) as { id?: CesiumNS.Entity } | undefined;
        const id = picked?.id?.id;
        if (typeof id === "string" && id.startsWith(STATION_ID)) {
          const [layerId, index] = id.slice(STATION_ID.length).split("#");
          stationClickRef.current(layerId, Number(index));
          return;
        }
        const hit = v.camera.pickEllipsoid(e.position, v.scene.globe.ellipsoid);
        if (!hit) return; // clicked space, not the globe
        const c = C.Cartographic.fromCartesian(hit);
        // 0..360° like the rest of the app (Cesium reports -180..180).
        clickRef.current({ lon: lon360(C.Math.toDegrees(c.longitude)), lat: C.Math.toDegrees(c.latitude) });
      }, C.ScreenSpaceEventType.LEFT_CLICK);

      // Hovering a station shows its name.
      let hovered: CesiumNS.Entity | undefined;
      handler.setInputAction((e: { endPosition: CesiumNS.Cartesian2 }) => {
        const picked = v.scene.pick(e.endPosition) as { id?: CesiumNS.Entity } | undefined;
        const entity = picked?.id?.label ? picked.id : undefined;
        if (entity === hovered) return;
        if (hovered?.label) hovered.label.show = new C.ConstantProperty(false);
        if (entity?.label) entity.label.show = new C.ConstantProperty(true);
        hovered = entity;
        v.scene.requestRender();
      }, C.ScreenSpaceEventType.MOUSE_MOVE);

      ref.current = { C, viewer: v, handles: new Map(), pin };
      sync(C, v, layersRef.current, ref.current.handles);
      showPin(markerRef.current);
    });

    return () => {
      cancelled = true;
      viewer?.destroy(); // also removes the click handler's canvas listeners
      ref.current = null;
    };
  }, []);

  function showPin(p: Point | null) {
    const r = ref.current;
    if (!r) return;
    r.pin.show = !!p;
    if (p) r.pin.position = new r.C.ConstantPositionProperty(r.C.Cartesian3.fromDegrees(p.lon, p.lat, MARKER_HEIGHT));
    r.viewer.scene.requestRender();
  }

  useEffect(() => {
    layersRef.current = layers;
    const r = ref.current;
    if (r) sync(r.C, r.viewer, layers, r.handles);
  }, [layers]);

  useEffect(() => {
    markerRef.current = marker;
    showPin(marker);
  }, [marker]);

  useEffect(() => {
    const r = ref.current;
    if (!focus || !r) return;
    // No camera padding in Cesium: widen the box so the panels don't cover it.
    const [w, s, e, n] = focus.bbox;
    const padX = (e - w) * 0.6;
    const padY = (n - s) * 0.6;
    r.viewer.camera.flyTo({
      destination: rect(r.C, [w - padX, Math.max(-89, s - padY), e + padX, Math.min(89, n + padY)]),
      duration: 1.2,
    });
  }, [focus]);

  // Cesium sizes itself to its container, so it gets an inner div that fills a fixed wrapper.
  return (
    <div className={styles.map}>
      <div ref={container} className={styles.mapCanvas} />
    </div>
  );
}
