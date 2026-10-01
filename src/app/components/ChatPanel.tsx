"use client";

import { useEffect, useRef, useState } from "react";
import {
  isCached,
  loadWebLLM,
  loadWllama,
  webllmProblem,
  WEBLLM_MODELS,
  WLLAMA_MODELS,
  type Backend,
  type Engine,
  type Message,
} from "../engines";
import {
  chatPrompt,
  finalizeQuery,
  routeMessage,
  wantsPlot,
  querySchema,
  routerPrompt,
  type ModelQuery,
  type RoutedQuery,
} from "../query";
import type { FinalQuery } from "../layers";
import { CATALOG, datasetTags, treeSummary } from "../datatree";
import { clearMatch, shortlist } from "../search";
import { retrieve, warmRag } from "../rag";
import styles from "../page.module.css";

type Turn = {
  role: "user" | "assistant";
  content: string;
  query?: FinalQuery;
  ms?: number;
};

// How many earlier turns the model sees; small models do worse with long context.
const HISTORY = 8;

// The last model the user loaded, so the next visit can start with it.
type Choice = { backend: Backend; model: string };
const CHOICE_KEY = "chat-model";
function savedChoice(): Choice | null {
  try {
    return JSON.parse(localStorage.getItem(CHOICE_KEY) ?? "null");
  } catch {
    return null;
  }
}
function saveChoice(c: Choice) {
  try {
    localStorage.setItem(CHOICE_KEY, JSON.stringify(c));
  } catch {}
}

// The first model already downloaded on this device: the last one used, then the lists'
// order (WebLLM first when it can run here). Null if none is cached.
async function cachedChoice(webllmOk: boolean): Promise<Choice | null> {
  const all: Choice[] = [
    ...(webllmOk ? WEBLLM_MODELS.map((m) => ({ backend: "webllm" as const, model: m.id })) : []),
    ...WLLAMA_MODELS.map((m) => ({ backend: "wllama" as const, model: m.id })),
  ];
  const saved = savedChoice();
  const known = all.find((c) => c.backend === saved?.backend && c.model === saved?.model);
  for (const c of known ? [known, ...all.filter((c) => c !== known)] : all) {
    if (await isCached(c.backend, c.model)) return c;
  }
  return null;
}

type Props = {
  // Called for each data request; returns a note for the chat, e.g. "Added to the map."
  onQuery: (query: FinalQuery) => Promise<string>;
  // Layer commands ("remove layer", "hide fiji"); returns the reply, or null if not a command.
  onCommand: (message: string) => string | null;
  // The data tree as text (datatree.ts), so the assistant knows what exists and what it can do.
  dataOutline: string;
};

export default function ChatPanel({ onQuery, onCommand, dataOutline }: Props) {
  const engineRef = useRef<Engine | null>(null);
  const endRef = useRef<HTMLDivElement | null>(null);
  // The last data request, so follow-ups ("plot it", "same for Tonga") can reuse its variable.
  const lastQueryRef = useRef<RoutedQuery | null>(null);
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

  // Set before the first await, so React's dev double-mount doesn't load the model twice.
  const autoLoadRef = useRef(false);
  useEffect(() => {
    if (autoLoadRef.current) return;
    autoLoadRef.current = true;
    webllmProblem().then(async (problem) => {
      setWebllmIssue(problem);
      if (!problem) pickBackend("webllm");
      // A model already on this device loads without a download, so start it right away.
      const cached = await cachedChoice(!problem);
      if (cached) {
        setBackend(cached.backend);
        setModel(cached.model);
        load(cached);
      }
    });
    // Once per page load, with the state as it was on mount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Braces matter: scrollIntoView can return a Promise, and React would treat it as a cleanup function.
  useEffect(() => {
    endRef.current?.scrollIntoView({ block: "end" });
  }, [turns, open]);

  function pickBackend(b: Backend) {
    setBackend(b);
    setModel((b === "webllm" ? WEBLLM_MODELS : WLLAMA_MODELS)[0].id);
  }

  async function load(choice: Choice = { backend, model }) {
    setError("");
    setLoaded("");
    setBusy(true);
    // The retrieval model is small; fetch it alongside the chat model.
    warmRag();
    try {
      const onProgress = (t: string, f: number) => {
        setStatus(t);
        setProgress(f);
      };
      engineRef.current =
        choice.backend === "webllm"
          ? await loadWebLLM(choice.model, onProgress)
          : await loadWllama(choice.model, onProgress);
      saveChoice(choice);
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
      // 1. Route: is this a data request? Search shortlists the datasets it might mean; the
      // model picks one (or none) and extracts the rest of the query (schema-constrained).
      const options = shortlist(content);
      const optionText = options.map((d) => `${d.id}: ${d.label} (${datasetTags(d)})`);
      const raw = JSON.parse(
        await engine.complete(
          [{ role: "system", content: routerPrompt(optionText) }, ...history, user],
          querySchema(options.map((d) => d.id)),
        ),
      ) as ModelQuery;

      const routed = routeMessage(raw, content, lastQueryRef.current, options, clearMatch(content)?.id ?? null);

      // A data request that could mean several datasets: ask, don't guess.
      if (routed && !routed.dataset && !routed.place && options.length) {
        const ms = Math.round(performance.now() - t0);
        const names = options.slice(0, 4).map((d) => `"${d.label}"`);
        const ask = `Which one do you mean: ${names.slice(0, -1).join(", ")}${names.length > 1 ? " or " : ""}${names.at(-1)}?`;
        setTurns((ts) => [...ts, { role: "assistant", content: ask, ms }]);
        return;
      }
      if (routed) {
        lastQueryRef.current = routed;
        const query = finalizeQuery(routed);
        const ms = Math.round(performance.now() - t0);
        const note = await onQuery(query);
        setTurns((ts) => [...ts, { role: "assistant", content: note, query, ms }]);
        return;
      }

      // A plot request we couldn't resolve: ask, rather than let the chat model pretend.
      if (wantsPlot(content)) {
        const ms = Math.round(performance.now() - t0);
        // Listed from the data tree, so it always matches what's in the catalog.
        const ask = `I couldn't tell which dataset you mean. The catalog has:\n${treeSummary()}\nName one to plot it.`;
        setTurns((ts) => [...ts, { role: "assistant", content: ask, ms }]);
        return;
      }

      // 2. Chat: stream a normal free-text reply, grounded in the closest knowledge passages.
      setTurns((ts) => [...ts, { role: "assistant", content: "" }]);
      // Retrieval is a bonus: if it can't load, answer without it.
      const passages = await retrieve(content).catch((e) => {
        console.warn("retrieval unavailable", e);
        return [];
      });
      const notes = passages.map((p) => `- [${p.title}] ${p.text}`).join("\n");
      const reply = await engine.stream(
        [{ role: "system", content: chatPrompt(dataOutline, notes) }, ...history, user],
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
        <span className={ready ? styles.dotOn : styles.dotOff} /> Ocean Assistant
      </button>
    );
  }

  return (
    <section className={`${styles.panel} ${styles.chatPanel}`}>
      <header className={styles.panelHeader}>
        <h2>
          <span className={ready ? styles.dotOn : styles.dotOff} /> Ocean Assistant
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
          <button onClick={() => load()} disabled={busy || webllmIssue === undefined}>
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
            {ready ? `Say hi, or try "plot ${CATALOG[0]?.label ?? "a dataset"}".` : "Load a model to start."}
          </p>
        )}
        {turns.map((t, i) => (
          <div key={i} className={t.role === "user" ? styles.user : styles.assistant}>
            {t.content || "…"}
            {t.query && (
              <>
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
