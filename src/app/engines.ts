import { CreateWebWorkerMLCEngine } from "@mlc-ai/web-llm";
// The package root points at raw TS sources; use the prebuilt ESM build.
import { Wllama } from "@wllama/wllama/esm/index.js";

// Both backends expose the same two calls: schema-constrained JSON, and streamed free text.
export type Message = { role: "system" | "user" | "assistant"; content: string };
export type OnText = (textSoFar: string) => void;
export type Engine = {
  backend: string;
  complete(messages: Message[], schema: object): Promise<string>;
  stream(messages: Message[], onText: OnText): Promise<string>;
};
export type Progress = (text: string, fraction: number) => void;

// With thinking disabled, Qwen3 replies still start with an empty
// "<think>\n\n</think>" block, which WebLLM includes in the returned text.
// Also hides a block that is still open mid-stream.
const stripThinking = (s: string) => s.replace(/<think>[\s\S]*?(<\/think>|$)/g, "").trim();

// Chat replies: low temperature keeps a small model factual; cap length so it doesn't ramble.
const CHAT = { temperature: 0.3, max_tokens: 512 };

async function collect(chunks: AsyncIterable<{ choices: { delta: { content?: string | null } }[] }>, onText: OnText) {
  let text = "";
  for await (const chunk of chunks) {
    text += chunk.choices[0]?.delta.content ?? "";
    onText(stripThinking(text));
  }
  return stripThinking(text);
}

export type ModelOption = { id: string; label: string };

// WebLLM: WebGPU only, fastest, needs maxStorageBuffersPerShaderStage >= 10.
export const WEBLLM_MODELS: ModelOption[] = [
  { id: "Qwen3-1.7B-q4f16_1-MLC", label: "Qwen3 1.7B (984 MB)" },
  { id: "Qwen3.5-0.8B-q4f16_1-MLC", label: "Qwen3.5 0.8B (447 MB)" },
  { id: "Qwen3-0.6B-q4f16_1-MLC", label: "Qwen3 0.6B (352 MB)" },
  { id: "Qwen2.5-0.5B-Instruct-q4f16_1-MLC", label: "Qwen2.5 0.5B (290 MB)" },
  { id: "Qwen3-4B-q4f16_1-MLC", label: "Qwen3 4B (~2.5 GB)" },
];

// Only Qwen3/3.5 have a thinking mode. For other models WebLLM would still inject an
// empty <think> block when enable_thinking is false, so leave the flag off for them.
const thinkingOff = (model: string) =>
  /^Qwen3/.test(model) ? { extra_body: { enable_thinking: false } } : {};

// wllama (llama.cpp): WebGPU where it can, otherwise CPU via WebAssembly.
// Files must stay under 2 GB unless split, so no 4B here.
export const WLLAMA_MODELS: ModelOption[] = [
  { id: "unsloth/Qwen3-1.7B-GGUF/Qwen3-1.7B-Q4_K_M.gguf", label: "Qwen3 1.7B (~1.1 GB)" },
  { id: "unsloth/Qwen3-0.6B-GGUF/Qwen3-0.6B-Q4_K_M.gguf", label: "Qwen3 0.6B (~0.4 GB)" },
];

// Returns why WebLLM can't run here, or null if it can. Uses the same adapter
// and limit that WebLLM checks when it initializes.
export async function webllmProblem(): Promise<string | null> {
  type Adapter = { limits: Record<string, number> };
  const gpu = (navigator as Navigator & {
    gpu?: { requestAdapter(o?: object): Promise<Adapter | null> };
  }).gpu;
  if (!gpu) return "no WebGPU in this browser";
  const adapter = await gpu.requestAdapter({ powerPreference: "high-performance" }).catch(() => null);
  if (!adapter) return "no WebGPU adapter found";
  const buffers = adapter.limits.maxStorageBuffersPerShaderStage;
  if (buffers < 10) return `GPU allows ${buffers} storage buffers per shader stage, WebLLM needs 10`;
  return null;
}

export async function loadWebLLM(model: string, onProgress: Progress): Promise<Engine> {
  const worker = new Worker(new URL("./llm.worker.ts", import.meta.url), { type: "module" });
  const engine = await CreateWebWorkerMLCEngine(worker, model, {
    initProgressCallback: (p) => onProgress(p.text, p.progress),
  });
  return {
    backend: "WebLLM · WebGPU",
    async complete(messages, schema) {
      const reply = await engine.chat.completions.create({
        messages,
        response_format: { type: "json_object", schema: JSON.stringify(schema) },
        temperature: 0,
        // Qwen3 "thinking" mode is slow and unnecessary for this task.
        ...thinkingOff(model),
      });
      return stripThinking(reply.choices[0].message.content ?? "");
    },
    async stream(messages, onText) {
      const chunks = await engine.chat.completions.create({
        messages,
        stream: true,
        ...CHAT,
        ...thinkingOff(model),
      });
      return collect(chunks, onText);
    },
  };
}

export async function loadWllama(model: string, onProgress: Progress): Promise<Engine> {
  const [owner, name, ...file] = model.split("/");
  const source = { repo: `${owner}/${name}`, file: file.join("/") };
  const progressCallback = ({ loaded, total }: { loaded: number; total: number }) =>
    onProgress(
      `Downloading ${source.file}: ${Math.round(loaded / 1e6)} / ${Math.round(total / 1e6)} MB`,
      total ? loaded / total : 0,
    );

  // Try the GPU first; if its WebGPU backend fails here, retry on the CPU.
  for (const gpuLayers of [undefined, 0]) {
    // wllama.wasm is copied into public/ by the postinstall script.
    const wllama = new Wllama({ default: "/wllama.wasm" }, { suppressNativeLog: true });
    // Safari lacks JSPI; compat mode (fetched from jsDelivr) lets it use WebGPU anyway.
    wllama.setCompat("default");
    try {
      await wllama.loadModelFromHF(source, { progressCallback, n_ctx: 2048, n_gpu_layers: gpuLayers });
    } catch (e) {
      await wllama.exit().catch(() => {});
      if (gpuLayers === 0) throw e;
      console.warn("wllama GPU load failed, retrying on CPU", e);
      onProgress("GPU load failed, retrying on CPU…", 0);
      continue;
    }
    const threads = wllama.getNumThreads();
    return {
      backend: `wllama · ${threads} CPU thread${threads === 1 ? "" : "s"}${gpuLayers === 0 ? " · GPU off" : ""}`,
      async complete(messages, schema) {
        const reply = await wllama.createChatCompletion({
          messages,
          response_format: { type: "json_schema", json_schema: { name: "query", schema, strict: true } },
          temperature: 0,
          max_tokens: 256,
          chat_template_kwargs: { enable_thinking: false },
        });
        return stripThinking(reply.choices[0].message.content ?? "");
      },
      async stream(messages, onText) {
        const chunks = await wllama.createChatCompletion({
          messages,
          stream: true,
          ...CHAT,
          chat_template_kwargs: { enable_thinking: false },
        });
        return collect(chunks, onText);
      },
    };
  }
  throw new Error("unreachable");
}
