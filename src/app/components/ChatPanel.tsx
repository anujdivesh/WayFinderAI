"use client";

import { useEffect, useRef, useState } from "react";
import {
  loadWebLLM,
  loadWllama,
  webllmProblem,
  WEBLLM_MODELS,
  WLLAMA_MODELS,
  type Engine,
  type Message,
} from "../engines";
import {
  chatPrompt,
  finalizeQuery,
  routeMessage,
  querySchema,
  routerPrompt,
  type ModelQuery,
} from "../query";
import type { FinalQuery } from "../layers";
import styles from "../page.module.css";

type Backend = "webllm" | "wllama";
type Turn = {
  role: "user" | "assistant";
  content: string;
  query?: FinalQuery;
  ms?: number;
};

// How many earlier turns the model sees; small models do worse with long context.
const HISTORY = 8;

type Props = {
  // Called for each data request; returns a note for the chat, e.g. "Added to the map."
  onQuery: (query: FinalQuery) => string;
  // Layer commands ("remove layer", "hide fiji"); returns the reply, or null if not a command.
  onCommand: (message: string) => string | null;
};

export default function ChatPanel({ onQuery, onCommand }: Props) {
  const engineRef = useRef<Engine | null>(null);
  const endRef = useRef<HTMLDivElement | null>(null);
  // The last data request, so follow-ups ("plot it", "same for Tonga") can reuse its variable.
  const lastQueryRef = useRef<ModelQuery | null>(null);
  const [open, setOpen] = useState(true);
  // undefined while checking; null means WebLLM can run here.
  const [webllmIssue, setWebllmIssue] = useState<string | null | undefined>(undefined);
  const [backend, setBackend] = useState<Backend>("wllama");
  const [model, setModel] = useState(WLLAMA_MODELS[0].id);
  const [status, setStatus] = useState("");
  const [progress, setProgress] = useState(0);
  const [loaded, setLoaded] = useState("");
  const [busy, setBusy] = useState(false);
  const [text, setText] = useState("");
  const [turns, setTurns] = useState<Turn[]>([]);
  const [error, setError] = useState("");

  useEffect(() => {
    webllmProblem().then((problem) => {
      setWebllmIssue(problem);
      if (!problem) pickBackend("webllm");
    });
  }, []);

  // Braces matter: scrollIntoView can return a Promise, and React would treat it as a cleanup function.
  useEffect(() => {
    endRef.current?.scrollIntoView({ block: "end" });
  }, [turns, open]);

  function pickBackend(b: Backend) {
    setBackend(b);
    setModel((b === "webllm" ? WEBLLM_MODELS : WLLAMA_MODELS)[0].id);
  }

  async function load() {
    setError("");
    setLoaded("");
    setBusy(true);
    try {
      const onProgress = (t: string, f: number) => {
        setStatus(t);
        setProgress(f);
      };
      engineRef.current =
        backend === "webllm" ? await loadWebLLM(model, onProgress) : await loadWllama(model, onProgress);
      setLoaded(engineRef.current.backend);
      setStatus("");
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }

  async function send() {
    const engine = engineRef.current;
    const content = text.trim();
    if (!engine || !content) return;
    setError("");
    setText("");
    setBusy(true);

    const history: Message[] = turns.slice(-HISTORY).map((t) => ({ role: t.role, content: t.content }));
    const user: Message = { role: "user", content };
    setTurns((ts) => [...ts, { role: "user", content }]);
    const setLast = (turn: Turn) => setTurns((ts) => [...ts.slice(0, -1), turn]);

    const t0 = performance.now();

    // 0. Layer commands are handled in code, without the model.
    const commandReply = onCommand(content);
    if (commandReply) {
      setTurns((ts) => [...ts, { role: "assistant", content: commandReply, ms: Math.round(performance.now() - t0) }]);
      setBusy(false);
      return;
    }

    try {
      // 1. Route: is this a data request? If so, extract the query (schema-constrained).
      const raw = JSON.parse(
        await engine.complete([{ role: "system", content: routerPrompt() }, ...history, user], querySchema),
      ) as ModelQuery;

      const routed = routeMessage(raw, content, lastQueryRef.current);
      if (routed) {
        lastQueryRef.current = routed;
        const query = finalizeQuery(routed);
        const ms = Math.round(performance.now() - t0);
        const note = onQuery(query);
        setTurns((ts) => [...ts, { role: "assistant", content: note, query, ms }]);
        return;
      }

      // 2. Chat: stream a normal free-text reply.
      setTurns((ts) => [...ts, { role: "assistant", content: "" }]);
      const reply = await engine.stream(
        [{ role: "system", content: chatPrompt() }, ...history, user],
        (soFar) => setLast({ role: "assistant", content: soFar }),
      );
      setLast({ role: "assistant", content: reply, ms: Math.round(performance.now() - t0) });
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }

  const ready = !!loaded;
  const models = backend === "webllm" ? WEBLLM_MODELS : WLLAMA_MODELS;

  if (!open) {
    return (
      <button className={`${styles.panel} ${styles.chatLauncher}`} onClick={() => setOpen(true)}>
        <span className={ready ? styles.dotOn : styles.dotOff} /> Ocean assistant
      </button>
    );
  }

  return (
    <section className={`${styles.panel} ${styles.chatPanel}`}>
      <header className={styles.panelHeader}>
        <h2>
          <span className={ready ? styles.dotOn : styles.dotOff} /> Ocean assistant
        </h2>
        <button className={styles.iconButton} onClick={() => setOpen(false)} aria-label="Minimise chat">
          –
        </button>
      </header>

      <div className={styles.chatSettings}>
        <div className={styles.row}>
          <select
            value={backend}
            onChange={(e) => pickBackend(e.target.value as Backend)}
            disabled={busy || webllmIssue === undefined}
            aria-label="Backend"
          >
            <option value="webllm" disabled={!!webllmIssue}>
              WebLLM (WebGPU)
            </option>
            <option value="wllama">wllama (any browser)</option>
          </select>
          <select value={model} onChange={(e) => setModel(e.target.value)} disabled={busy} aria-label="Model">
            {models.map((m) => (
              <option key={m.id} value={m.id}>
                {m.label}
              </option>
            ))}
          </select>
          <button onClick={load} disabled={busy || webllmIssue === undefined}>
            {ready ? "Reload" : "Load"}
          </button>
        </div>
        <p className={styles.small}>
          {loaded
            ? `Loaded: ${loaded}. Runs on your device.`
            : webllmIssue === undefined
              ? "Checking WebGPU…"
              : webllmIssue === null
                ? "WebGPU supported: WebLLM is fastest."
                : `WebLLM unavailable (${webllmIssue}); wllama works but is slower.`}
        </p>
        {status && (
          <div className={styles.status}>
            <progress value={progress} max={1} />
            <span>{status}</span>
          </div>
        )}
      </div>

      <div className={styles.messages}>
        {turns.length === 0 && (
          <p className={styles.muted}>
            {ready ? 'Say hi, or try "average SST around Fiji in August 2025".' : "Load a model to start."}
          </p>
        )}
        {turns.map((t, i) => (
          <div key={i} className={t.role === "user" ? styles.user : styles.assistant}>
            {t.content || "…"}
            {t.query && (
              <>
                {!t.query.variable && <p className={styles.warn}>Which dataset would you like, e.g. SST anomaly?</p>}
                {t.query.placeText && !t.query.place && (
                  <p className={styles.warn}>I don&rsquo;t know where &ldquo;{t.query.placeText}&rdquo; is yet.</p>
                )}
              </>
            )}
            {t.ms !== undefined && <span className={styles.ms}>{t.ms} ms</span>}
          </div>
        ))}
        {error && <p className={styles.error}>{error}</p>}
        <div ref={endRef} />
      </div>

      <form
        className={styles.composer}
        onSubmit={(e) => {
          e.preventDefault();
          send();
        }}
      >
        <input
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder={ready ? "Message" : "Load a model first"}
          disabled={!ready}
        />
        <button type="submit" disabled={!ready || busy || !text.trim()}>
          {busy && ready ? "…" : "Send"}
        </button>
        <button type="button" onClick={() => {
            setTurns([]);
            lastQueryRef.current = null;
          }} disabled={busy || turns.length === 0} aria-label="Clear chat">
          Clear
        </button>
      </form>
    </section>
  );
}
