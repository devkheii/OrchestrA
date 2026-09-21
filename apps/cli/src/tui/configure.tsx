import { useState } from "react";
import { Box, Text } from "ink";
import SelectInput from "ink-select-input";
import TextInput from "ink-text-input";
import {
  DEFAULT_START_OPTIONS,
  RUNTIMES,
  runtimeById,
  type RuntimeField,
  type RuntimeId,
  type RuntimeSpec,
  type StartOptions,
} from "@dem/engine";

/**
 * Adding a provider: pick a runtime, then answer what that runtime needs
 * (SPEC §33.5).
 *
 * There were three of these. `dem setup`, the start menu and `/provider add`
 * each had their own screen over the same data, 851 lines between them — which
 * is the drift this project spends most of its effort preventing, built by the
 * person preventing it.
 *
 * One component now, used by all three. What it asks depends on the runtime,
 * because asking Ollama for a `.gguf` path or the Anthropic API for a port is
 * how a configuration screen teaches people to stop reading it.
 */

export interface ConfiguredProvider {
  name: string;
  runtime: RuntimeId;
  baseUrl?: string | undefined;
  model?: string | undefined;
  modelPath?: string | undefined;
  options?: StartOptions | undefined;
  /** Plain value; the caller puts it in the credential store. */
  apiKey?: string | undefined;
}

export interface ConfigureProps {
  onDone: (provider: ConfiguredProvider) => void;
  onCancel: () => void;
  /** Weights found on this machine, offered rather than typed. */
  weights?: ReadonlyArray<{ label: string; path: string }>;
}

type Stage = "runtime" | "field" | "options";

export function Configure({ onDone, onCancel, weights = [] }: ConfigureProps) {
  const [runtime, setRuntime] = useState<RuntimeSpec | undefined>(undefined);
  const [stage, setStage] = useState<Stage>("runtime");
  const [fieldIndex, setFieldIndex] = useState(0);
  const [draft, setDraft] = useState("");
  const [entry, setEntry] = useState<Partial<ConfiguredProvider>>({});

  if (stage === "runtime") {
    return (
      <Box flexDirection="column">
        <Text dimColor>what serves the model?</Text>
        <SelectInput
          items={RUNTIMES.map((r) => ({
            key: r.id,
            // The posture is in the list, not behind a later screen: whether
            // context leaves this machine is the first thing to know.
            label: `${r.local ? "local " : "remote"}  ${r.label.padEnd(20)} ${r.summary}`,
            value: r.id,
          }))}
          onSelect={(item) => {
            const picked = runtimeById(String(item.value));
            if (!picked) return onCancel();
            setRuntime(picked);
            setEntry({ runtime: picked.id, ...(picked.serves ? { options: DEFAULT_START_OPTIONS } : {}) });
            setStage("field");
            setFieldIndex(0);
          }}
        />
      </Box>
    );
  }

  if (!runtime) return null;

  // The name is asked for first and is common to every runtime.
  const fields: Array<RuntimeField | "name"> = ["name", ...runtime.fields];
  const field = fields[fieldIndex];

  if (field === "startOptions") {
    return (
      <StartOptionsForm
        options={entry.options ?? DEFAULT_START_OPTIONS}
        onDone={(options) => {
          const next = { ...entry, options };
          setEntry(next);
          advance(next);
        }}
      />
    );
  }

  if (field === "modelPath" && weights.length > 0 && !entry.modelPath) {
    return (
      <Box flexDirection="column">
        <Text dimColor>which weights?</Text>
        <SelectInput
          items={[
            ...weights.map((w) => ({ key: w.path, label: w.label, value: w.path })),
            { key: "\u0000type", label: "type a path...", value: "\u0000type" },
          ]}
          onSelect={(item) => {
            const value = String(item.value);
            if (value === "\u0000type") {
              // Falls through to the text field below by recording nothing.
              setEntry({ ...entry, modelPath: "" });
              return;
            }
            const next = { ...entry, modelPath: value };
            setEntry(next);
            advance(next);
          }}
        />
      </Box>
    );
  }

  return (
    <Box>
      <Text>{questionFor(field, runtime)}</Text>
      <TextInput
        value={draft}
        onChange={setDraft}
        onSubmit={(value) => {
          const trimmed = value.trim();
          setDraft("");

          // A name and an endpoint are the two things nothing can proceed
          // without; everything else may be decided later.
          if (!trimmed && (field === "name" || required(field, runtime))) return onCancel();

          const next = { ...entry, ...(trimmed ? { [field as string]: trimmed } : {}) };
          setEntry(next);
          advance(next);
        }}
        {...(field === "apiKey" ? { mask: "•" } : {})}
      />
    </Box>
  );

  function advance(current: Partial<ConfiguredProvider>) {
    const nextIndex = fieldIndex + 1;
    if (nextIndex < fields.length) {
      setFieldIndex(nextIndex);
      return;
    }

    onDone({
      name: current.name ?? runtime!.id,
      runtime: runtime!.id,
      ...(current.baseUrl ? { baseUrl: current.baseUrl } : {}),
      ...(current.model ? { model: current.model } : {}),
      ...(current.modelPath ? { modelPath: current.modelPath } : {}),
      ...(current.options ? { options: current.options } : {}),
      ...(current.apiKey ? { apiKey: current.apiKey } : {}),
    });
  }
}

function required(field: RuntimeField | "name" | undefined, runtime: RuntimeSpec): boolean {
  if (field === "modelPath") return true;
  // An endpoint with a default does not have to be typed.
  if (field === "baseUrl") return !runtime.defaultBaseUrl;
  return false;
}

function questionFor(field: RuntimeField | "name" | undefined, runtime: RuntimeSpec): string {
  switch (field) {
    case "name": return `a name for it (e.g. ${suggestName(runtime)}): `;
    case "modelPath": return "path to the .gguf: ";
    case "model": return "model name: ";
    case "baseUrl":
      return runtime.defaultBaseUrl
        ? `endpoint [${runtime.defaultBaseUrl}]: `
        : "endpoint URL: ";
    case "apiKey": return "API key (blank if none): ";
    default: return "> ";
  }
}

function suggestName(runtime: RuntimeSpec): string {
  return runtime.id.replace(/[^a-z0-9]+/g, "-");
}

/**
 * The options only a runtime we start can use.
 *
 * Presented with what was measured attached, because these are not
 * preferences: `q4_0` took a model from 46 of 60 to 0 of 60 on this project's
 * own benchmark, and it looks like the obvious choice for someone short of
 * memory.
 */
function StartOptionsForm({
  options,
  onDone,
}: {
  options: StartOptions;
  onDone: (options: StartOptions) => void;
}) {
  const [current, setCurrent] = useState(options);

  const rows = [
    {
      key: "accept",
      label: `use these  (context ${current.contextSize}, ${current.kvCache} cache, ` +
        `${current.gpuLayers === -1 ? "auto offload" : `${current.gpuLayers} layers`}` +
        `${current.flashAttention ? ", flash attention" : ""})`,
      value: "accept",
    },
    { key: "ctx", label: `context size: ${current.contextSize}`, value: "ctx" },
    {
      key: "kv",
      label: `KV cache: ${current.kvCache}` +
        (current.kvCache === "q4_0" ? "   — measured 0/60 on this project; not recommended" : ""),
      value: "kv",
    },
    {
      key: "ngl",
      label: `GPU layers: ${current.gpuLayers === -1 ? "auto (fit what memory allows)" : current.gpuLayers}`,
      value: "ngl",
    },
    { key: "fa", label: `flash attention: ${current.flashAttention ? "on" : "off"}`, value: "fa" },
  ];

  return (
    <Box flexDirection="column">
      <Text dimColor>start options</Text>
      <SelectInput
        items={rows}
        onSelect={(item) => {
          switch (String(item.value)) {
            case "accept":
              return onDone(current);
            case "kv":
              return setCurrent({ ...current, kvCache: nextCache(current.kvCache) });
            case "ngl":
              return setCurrent({ ...current, gpuLayers: current.gpuLayers === -1 ? 999 : -1 });
            case "fa":
              return setCurrent({ ...current, flashAttention: !current.flashAttention });
            case "ctx":
              return setCurrent({ ...current, contextSize: nextContext(current.contextSize) });
          }
        }}
      />
      <Text dimColor>  enter to change a value, then "use these"</Text>
    </Box>
  );
}

function nextCache(current: StartOptions["kvCache"]): StartOptions["kvCache"] {
  return current === "q8_0" ? "fp16" : current === "fp16" ? "q4_0" : "q8_0";
}

function nextContext(current: number | undefined): number {
  const sizes = [4096, 8192, 16384, 32768];
  const index = sizes.indexOf(current ?? 8192);
  return sizes[(index + 1) % sizes.length]!;
}
