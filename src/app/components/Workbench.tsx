"use client";

import { useState } from "react";
import { timeRange } from "../catalog";
import { BASEMAPS, type Layer } from "../layers";
import styles from "../page.module.css";

type Props = {
  layers: Layer[];
  basemap: string;
  onBasemap: (id: string) => void;
  onChange: (id: string, patch: Partial<Layer>) => void;
  onRemove: (id: string) => void;
  onZoom: (layer: Layer) => void;
  onMove: (id: string, dir: -1 | 1) => void;
};

export default function Workbench(props: Props) {
  const { layers, basemap, onBasemap, onChange, onRemove, onZoom, onMove } = props;
  const [open, setOpen] = useState(true);

  if (!open) {
    return (
      <button className={`${styles.panel} ${styles.workbenchTab}`} onClick={() => setOpen(true)}>
        Workbench{layers.length ? ` (${layers.length})` : ""}
      </button>
    );
  }

  return (
    <aside className={`${styles.panel} ${styles.workbench}`}>
      <header className={styles.panelHeader}>
        <h2>Workbench</h2>
        <button className={styles.iconButton} onClick={() => setOpen(false)} aria-label="Collapse workbench">
          ‹
        </button>
      </header>

      <label className={styles.field}>
        <span>Basemap</span>
        <select value={basemap} onChange={(e) => onBasemap(e.target.value)}>
          {BASEMAPS.map((b) => (
            <option key={b.id} value={b.id}>
              {b.label}
            </option>
          ))}
        </select>
      </label>

      <h3 className={styles.sectionTitle}>Layers</h3>
      {layers.length === 0 ? (
        <p className={styles.muted}>
          No layers yet. Ask the Ocean assistant, e.g. &ldquo;SST anomaly around Fiji&rdquo;.
        </p>
      ) : (
        <ul className={styles.layerList}>
          {layers.map((l, i) => (
            <li key={l.id} className={styles.layer}>
              <div className={styles.layerTop}>
                <input
                  type="checkbox"
                  checked={l.visible}
                  onChange={(e) => onChange(l.id, { visible: e.target.checked })}
                  aria-label={`Show ${l.title}`}
                />
                <span className={styles.swatch} style={{ background: l.color }} />
                <div className={styles.layerText}>
                  <strong>{l.title}</strong>
                  {l.subtitle && <span>{l.subtitle}</span>}
                </div>
              </div>
              {l.wms && (
                <>
                  <label className={styles.dateField}>
                    <span>Date</span>
                    <input
                      type="date"
                      value={l.wms.date}
                      {...timeRange(l.wms.layer)}
                      onChange={(e) => e.target.value && onChange(l.id, { wms: { ...l.wms!, date: e.target.value } })}
                    />
                  </label>
                  {/* crossOrigin: the page is cross-origin isolated, so images need CORS. */}
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img className={styles.legend} src={l.wms.layer.legend_url} alt={`${l.title} legend`} crossOrigin="anonymous" />
                </>
              )}
              <div className={styles.layerControls}>
                <input
                  type="range"
                  min={0}
                  max={1}
                  step={0.05}
                  value={l.opacity}
                  onChange={(e) => onChange(l.id, { opacity: Number(e.target.value) })}
                  aria-label="Opacity"
                />
                <button className={styles.iconButton} onClick={() => onMove(l.id, -1)} disabled={i === 0} aria-label="Move up">
                  ↑
                </button>
                <button
                  className={styles.iconButton}
                  onClick={() => onMove(l.id, 1)}
                  disabled={i === layers.length - 1}
                  aria-label="Move down"
                >
                  ↓
                </button>
                <button className={styles.iconButton} onClick={() => onZoom(l)} disabled={!l.bbox} aria-label="Zoom to layer">
                  ⌖
                </button>
                <button className={styles.iconButton} onClick={() => onRemove(l.id)} aria-label="Remove layer">
                  ✕
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </aside>
  );
}
