/**
 * Runtimes: who serves a model, and what that implies (SPEC §33.5).
 *
 * Three things were one thing. A provider entry held `baseUrl`, `model`,
 * `apiKey` and `modelPath`, which conflates:
 *
 *   the runtime     who serves it, and whether we start it
 *   the model       which weights, or which name at that runtime
 *   the connection  where it is and what authenticates
 *
 * Without the first, every local server was "an OpenAI-compatible baseUrl", so
 * there was no way to say llama.cpp rather than Ollama — and no place to put
 * the options that only llama.cpp has. Those options are not decoration:
 * measured on this project, `-ctk q4_0` took a model from 46/60 to 0/60,
 * `-ngl 999` at an 8k context killed the server mid-run, and `q8_0` with flash
 * attention cut a pass from 33 minutes to 3. All of them were reachable only
 * by editing the harness.
 *
 * The runtime decides what is asked for, what is started, and what the gate
 * says. Nothing else has to branch on it.
 */

export type RuntimeId =
  | "llama.cpp"
  | "ollama"
  | "lm-studio"
  | "openai"
  | "anthropic"
  | "claude-cli";

/** A field a runtime needs, for a menu that asks only what applies. */
export type RuntimeField =
  | "modelPath"
  | "model"
  | "baseUrl"
  | "apiKey"
  | "startOptions";

export interface RuntimeSpec {
  id: RuntimeId;
  label: string;
  /** One line, for a menu where the difference has to be visible. */
  summary: string;
  /** Whether the harness starts the server itself. */
  serves: boolean;
  /** What to ask for, in order. */
  fields: readonly RuntimeField[];
  /** Offered when the user has not said otherwise. */
  defaultBaseUrl?: string;
  /**
   * Whether context leaves this machine.
   *
   * `claude-cli` is the reason this is a property of the runtime rather than a
   * test on the URL: the binary is local and every prompt goes to a third
   * party. The gate follows the data (invariant 1).
   */
  local: boolean;
  /** Whether tools are known not to work. Undefined means "measure it". */
  toolCalling?: false;
}

export const RUNTIMES: readonly RuntimeSpec[] = [
  {
    id: "llama.cpp",
    label: "llama.cpp",
    summary: "dem serves a .gguf itself — full control of context, offload and cache",
    serves: true,
    fields: ["modelPath", "startOptions"],
    defaultBaseUrl: "http://127.0.0.1:8099",
    local: true,
  },
  {
    id: "ollama",
    label: "Ollama",
    summary: "attach to a running Ollama",
    serves: false,
    fields: ["baseUrl", "model"],
    defaultBaseUrl: "http://127.0.0.1:11434/v1",
    local: true,
  },
  {
    id: "lm-studio",
    label: "LM Studio",
    summary: "attach to a running LM Studio server",
    serves: false,
    fields: ["baseUrl", "model"],
    defaultBaseUrl: "http://127.0.0.1:1234/v1",
    local: true,
  },
  {
    id: "openai",
    label: "OpenAI-compatible",
    summary: "any endpoint speaking the OpenAI API, here or elsewhere",
    serves: false,
    fields: ["baseUrl", "model", "apiKey"],
    local: false,
  },
  {
    id: "anthropic",
    label: "Anthropic API",
    summary: "bills per request; supports tool calling",
    serves: false,
    fields: ["model", "apiKey"],
    local: false,
  },
  {
    id: "claude-cli",
    label: "Claude Code CLI",
    summary: "your subscription's rate limit, not an API key — but no tool calling",
    serves: false,
    fields: ["model"],
    local: false,
    // Its own tools are stripped to keep them out of the permission broker,
    // and it offers none of ours (invariant 41).
    toolCalling: false,
  },
];

export function runtimeById(id: string | undefined): RuntimeSpec | undefined {
  return RUNTIMES.find((runtime) => runtime.id === id);
}

/**
 * Options only a runtime we start can use.
 *
 * Every one of these was measured on this project and reachable only by
 * editing source. `contextSize` and `llamaCommand` did exist — at the top
 * level of settings, where they applied to whichever provider happened to be
 * selected, which is the same defect `modelPath` had.
 */
export interface StartOptions {
  /** Tokens of context. An agent turn with tool results outgrows 4096 fast. */
  contextSize?: number | undefined;
  /** Layers on the GPU. -1 lets llama.cpp fit as many as memory allows. */
  gpuLayers?: number | undefined;
  /**
   * KV cache quantization.
   *
   * `q8_0` measured identical scores to fp16 and eleven times faster. `q4_0`
   * measured 0 of 60 — not a quality trade, destruction — so it is offered
   * with that said rather than as one option among equals.
   */
  kvCache?: "fp16" | "q8_0" | "q4_0" | undefined;
  flashAttention?: boolean | undefined;
  /** Anything else, for someone who knows their hardware better than we do. */
  extraArgs?: readonly string[] | undefined;
}

/** The server arguments a set of options means. */
export function startArgs(options: StartOptions): string[] {
  const args: string[] = [];

  if (options.contextSize) args.push("-c", String(options.contextSize));
  if (options.gpuLayers !== undefined) args.push("-ngl", String(options.gpuLayers));
  if (options.flashAttention) args.push("-fa", "on");

  if (options.kvCache && options.kvCache !== "fp16") {
    args.push("-ctk", options.kvCache, "-ctv", options.kvCache);
  }

  args.push(...(options.extraArgs ?? []));
  return args;
}

/**
 * What to start with when nobody has said.
 *
 * Measured rather than guessed: this is the configuration that took a pass
 * from 33 minutes to 3 with no change in score, and `-ngl -1` rather than 999
 * because forcing every layer onto an 8GB card at this context loaded, served
 * one request and then died.
 */
export const DEFAULT_START_OPTIONS: StartOptions = {
  contextSize: 8192,
  gpuLayers: -1,
  kvCache: "q8_0",
  flashAttention: true,
};
