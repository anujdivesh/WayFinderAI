"use client";

import { useEffect, useRef, useState } from "react";
import {
  CategoryScale,
  Chart,
  LinearScale,
  LineController,
  LineElement,
  PointElement,
  ScatterController,
  Tooltip,
  type Plugin,
} from "chart.js";
import { isDirection, type ChartRequest, type Series } from "../timeseries";
import styles from "../page.module.css";

Chart.register(LineController, ScatterController, LineElement, PointElement, LinearScale, CategoryScale, Tooltip);

type Props = { request: ChartRequest | null; onClose: () => void };

const COMPASS = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"];

// Hairline that follows the hovered date, so readers aim at a date, not at a 2px line.
const hoverLine: Plugin = {
  id: "hoverLine",
  afterDatasetsDraw(chart) {
    const active = chart.tooltip?.getActiveElements()[0];
    if (!active) return;
    const { ctx, chartArea } = chart;
    ctx.save();
    ctx.strokeStyle = css("--muted");
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(active.element.x, chartArea.top);
    ctx.lineTo(active.element.x, chartArea.bottom);
    ctx.stroke();
    ctx.restore();
  },
};

const css = (name: string) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

// Daily data shows dates; sub-daily data also shows the UTC hour.
function timeLabels(times: string[]) {
  const subDaily = times.length > 1 && Date.parse(times[1]) - Date.parse(times[0]) < 864e5;
  const fmt = new Intl.DateTimeFormat("en-GB", {
    day: "numeric",
    month: "short",
    year: "numeric",
    ...(subDaily ? { hour: "2-digit", minute: "2-digit" } : {}),
    timeZone: "UTC",
  });
  return times.map((t) => fmt.format(new Date(t)) + (subDaily ? " UTC" : ""));
}

const round = (v: number | null) => (v === null ? "–" : Number(v.toFixed(2)).toString());

// One chart per variable (small multiples): variables have different units, and a
// second y-axis would make them look comparable when they aren't.
function SeriesChart({ series }: { series: Series }) {
  const canvas = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    if (!canvas.current) return;
    const direction = isDirection(series.label);
    const color = css("--series-1");
    const ink = css("--muted");
    const grid = css("--panel-border");
    const unit = direction ? "°" : series.unit;

    const chart = new Chart(canvas.current, {
      type: direction ? "scatter" : "line",
      data: {
        labels: timeLabels(series.times),
        datasets: [
          {
            label: series.label,
            data: direction
              ? series.values.map((v, i) => ({ x: i, y: v === null ? null : ((v % 360) + 360) % 360 }))
              : series.values,
            borderColor: color,
            backgroundColor: color,
            borderWidth: 2,
            pointRadius: direction ? 2 : 0,
            pointHoverRadius: 4,
            pointHoverBorderColor: css("--panel"),
            pointHoverBorderWidth: 2,
            spanGaps: false,
            tension: 0,
          },
        ],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        animation: false,
        interaction: { mode: "index", intersect: false },
        scales: {
          x: {
            type: direction ? "linear" : "category",
            ticks: {
              color: ink,
              maxTicksLimit: 6,
              maxRotation: 0,
              autoSkip: true,
              ...(direction ? { callback: (v) => timeLabels([series.times[Number(v)] ?? ""])[0] ?? "" } : {}),
            },
            grid: { display: false },
            border: { color: grid },
            ...(direction ? { min: 0, max: series.times.length - 1 } : {}),
          },
          y: {
            ticks: {
              color: ink,
              maxTicksLimit: 5,
              ...(direction ? { stepSize: 90, callback: (v) => COMPASS[Number(v) / 45] ?? v } : {}),
            },
            grid: { color: grid },
            border: { display: false },
            ...(direction ? { min: 0, max: 360 } : {}),
          },
        },
        plugins: {
          legend: { display: false }, // one series per chart: the heading names it
          tooltip: {
            displayColors: false,
            callbacks: {
              title: (items) => timeLabels([series.times[items[0].dataIndex]])[0],
              label: (item) => `${round(item.parsed.y)}${unit ? ` ${unit}` : ""}`,
            },
          },
        },
      },
      plugins: [hoverLine],
    });
    return () => chart.destroy();
  }, [series]);

  return (
    <div className={styles.chartBox}>
      <canvas ref={canvas} role="img" aria-label={`${series.label} time series`} />
    </div>
  );
}

export default function ChartPanel({ request, onClose }: Props) {
  const [series, setSeries] = useState<Series[] | null>(null);
  const [error, setError] = useState("");
  const [loadedFor, setLoadedFor] = useState<ChartRequest | null>(null);
  const [table, setTable] = useState(false);

  useEffect(() => {
    if (!request) return;
    const ctrl = new AbortController();
    request.load(ctrl.signal).then(
      (s) => {
        setSeries(s);
        setError("");
        setLoadedFor(request);
      },
      (e) => {
        if (ctrl.signal.aborted) return;
        setSeries(null);
        setError(String(e));
        setLoadedFor(request);
      },
    );
    return () => ctrl.abort(); // a newer click replaces an in-flight request
  }, [request]);

  if (!request) return null;
  const loading = loadedFor !== request;
  const empty = !loading && !!series && (!series.length || series.every((s) => s.values.every((v) => v === null)));

  return (
    <section className={`${styles.panel} ${styles.chartPanel}`} aria-label="Time series">
      <header className={styles.panelHeader}>
        <div className={styles.chartTitle}>
          <h2>{request.title}</h2>
          <span className={styles.small}>
            {request.subtitle}
          </span>
        </div>
        <div className={styles.chartActions}>
          <button
            className={styles.textButton}
            onClick={() => setTable((t) => !t)}
            disabled={loading || !series || empty}
            aria-pressed={table}
          >
            {table ? "Chart" : "Table"}
          </button>
          <button className={styles.iconButton} onClick={onClose} aria-label="Close time series">
            ✕
          </button>
        </div>
      </header>

      {loading && <p className={styles.muted}>Fetching data…</p>}
      {!loading && error && <p className={styles.error}>{error}</p>}
      {!loading && empty && (
        <p className={styles.muted}>{request.empty}</p>
      )}

      {!loading && series && !empty && !table && (
        <div className={styles.charts}>
          {series.map((s) => (
            <figure key={s.variable} className={styles.chartFigure}>
              <figcaption>
                {s.label}
                {isDirection(s.label) ? " (°)" : s.unit ? ` (${s.unit})` : ""}
              </figcaption>
              <SeriesChart series={s} />
            </figure>
          ))}
        </div>
      )}

      {!loading && series && !empty && table && (
        <div className={styles.tableWrap}>
          <table className={styles.dataTable}>
            <thead>
              <tr>
                <th>Time</th>
                {series.map((s) => (
                  <th key={s.variable}>
                    {s.label}
                    {s.unit && !isDirection(s.label) ? ` (${s.unit})` : ""}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {timeLabels(series[0].times).map((t, i) => (
                <tr key={i}>
                  <td>{t}</td>
                  {series.map((s) => (
                    <td key={s.variable}>{round(s.values[i] ?? null)}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
