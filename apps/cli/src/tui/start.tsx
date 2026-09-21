import { createElement, useEffect, useState } from "react";
import { Box, Text, render } from "ink";
import SelectInput from "ink-select-input";
import TextInput from "ink-text-input";
import { discoverServers, discoverWeights, humanSize } from "@dem/engine";

/**
 * What `dem` shows before it connects to anything.
 *
 * It used to resolve whatever was configured and connect. When that endpoint
 * was unreachable the configuration check refused to open a session — which
 * was right, and left no way out, because the only thing that can change the
 * provider is `/provider`, which lives inside the session that would not open.
 * A gate that cannot be passed and cannot be reconfigured is a wall.
 *
 * Choosing first dissolves that: there is nothing to be locked out of.
 *
 * Adding a provider happens **here**, not by dropping out to a prompt. Ink
 * puts stdin in raw mode, and a readline prompt opened after unmounting reads
 * nothing — the questions appeared and the process exited without taking an
 * answer. Anything that needs typing is a field in this component.
 */

export interface ManualProvider {
  name: string;
  baseUrl: string;
  model?: string | undefined;
  /** Plain value, to be put in the credential store by the caller. */
  apiKey?: string | undefined;
}

export interface StartChoice {
  /** A configured provider name, or undefined for the flat configuration. */
  provider?: string | undefined;
  /** A discovered endpoint the user picked, to be written before connecting. */
  newEndpoint?:
    | { baseUrl: string; model?: string | undefined; modelPath?: string | undefined }
    | undefined;
  /** An endpoint this menu could not discover, typed in full. */
  manual?: ManualProvider | undefined;
  /** The user left without choosing. */
  cancelled?: boolean;
}

interface Entry {
  key: string;
  label: string;
  value: string;
  choice: StartChoice;
}

export interface StartOptions {
  workspace: string;
  /** Providers already in config, with the one config names as current. */
  configured: Array<{ name: string; detail: string; current: boolean }>;
  /** The flat configuration, when there is one and no named providers. */
  flat?: { detail: string } | undefined;
}

const MANUAL = "\u0000manual";

export async function pickAtStart(options: StartOptions): Promise<StartChoice> {
  return new Promise((resolve) => {
    let answered = false;
    const app = render(
      createElement(Start, {
        ...options,
        onChoose: (choice: StartChoice) => {
          answered = true;
          app.unmount();
          resolve(choice);
        },
      }),
      { exitOnCtrlC: true },
    );

    // Ctrl-C leaves without choosing rather than starting something.
    void app.waitUntilExit().then(() => {
      if (!answered) resolve({ cancelled: true });
    });
  });
}

type Step = "pick" | "name" | "url" | "model" | "key";

function Start({
  workspace,
  configured,
  flat,
  onChoose,
}: StartOptions & { onChoose: (choice: StartChoice) => void }) {
  const [found, setFound] = useState<Entry[] | undefined>(undefined);
  const [step, setStep] = useState<Step>("pick");
  const [draft, setDraft] = useState("");
  const [entry, setEntry] = useState<ManualProvider>({ name: "", baseUrl: "" });

  // Discovery runs while the configured entries are already on screen, so the
  // list is useful immediately and grows, rather than making someone wait for
  // a scan of a machine that may have nothing on it.
  useEffect(() => {
    let live = true;
    void (async () => {
      const [servers, weights] = await Promise.all([discoverServers(), discoverWeights()]);
      if (!live) return;

      setFound([
        ...servers.flatMap((server) =>
          (server.models.length ? server.models.slice(0, 4) : [undefined]).map((model) => ({
            key: `${server.baseUrl}:${model ?? ""}`,
            label: `${server.kind}${model ? ` — ${model}` : ""}`,
            value: `${server.baseUrl}:${model ?? ""}`,
            choice: {
              newEndpoint: { baseUrl: `${server.baseUrl}/v1`, ...(model ? { model } : {}) },
            } as StartChoice,
          })),
        ),
        ...weights.slice(0, 4).map((w) => {
          const name = w.path.split(/[\\/]/).pop() ?? w.path;
          return {
            key: w.path,
            label: `${name}  ${humanSize(w.sizeBytes)}`,
            value: w.path,
            choice: {
              newEndpoint: {
                baseUrl: "http://127.0.0.1:8099",
                model: name.replace(/\.gguf$/i, ""),
                // Weights travel with the endpoint that serves them.
                modelPath: w.path,
              },
            } as StartChoice,
          };
        }),
      ]);
    })();
    return () => {
      live = false;
    };
  }, []);

  const entries: Entry[] = [
    ...configured.map((item) => ({
      key: `cfg:${item.name}`,
      label: `${item.current ? "• " : "  "}${item.name}   ${item.detail}`,
      value: `cfg:${item.name}`,
      choice: { provider: item.name } as StartChoice,
    })),
    ...(flat && configured.length === 0
      ? [{ key: "flat", label: `• ${flat.detail}`, value: "flat", choice: {} as StartChoice }]
      : []),
    ...(found ?? []),
    {
      key: MANUAL,
      // Everything on this machine is already above, so "add" can only mean
      // an endpoint nothing here can find.
      label: "somewhere else — type an endpoint",
      value: MANUAL,
      choice: {},
    },
  ];

  if (step !== "pick") {
    return (
      <Box flexDirection="column">
        <Box marginBottom={1}>
          <Text bold>dem</Text>
          <Text dimColor>  adding a provider</Text>
        </Box>
        <Field
          step={step}
          draft={draft}
          setDraft={setDraft}
          onSubmit={(value) => {
            const trimmed = value.trim();
            setDraft("");

            if (step === "name") {
              if (!trimmed) return onChoose({ cancelled: true });
              setEntry((e) => ({ ...e, name: trimmed }));
              setStep("url");
            } else if (step === "url") {
              if (!trimmed) return onChoose({ cancelled: true });
              setEntry((e) => ({ ...e, baseUrl: trimmed }));
              setStep("model");
            } else if (step === "model") {
              setEntry((e) => ({ ...e, ...(trimmed ? { model: trimmed } : {}) }));
              setStep("key");
            } else {
              // The key is optional: a local endpoint usually needs none, and
              // an empty answer must not look like a failure.
              onChoose({ manual: { ...entry, ...(trimmed ? { apiKey: trimmed } : {}) } });
            }
          }}
        />
      </Box>
    );
  }

  return (
    <Box flexDirection="column">
      <Box marginBottom={1}>
        <Text bold>dem</Text>
        <Text dimColor>  {workspace}</Text>
      </Box>
      <Text dimColor>which model?</Text>
      <SelectInput
        items={entries.map((e) => ({ key: e.key, label: e.label, value: e.value }))}
        onSelect={(item) => {
          if (item.value === MANUAL) {
            setStep("name");
            return;
          }
          const chosen = entries.find((e) => e.value === item.value);
          if (chosen) onChoose(chosen.choice);
        }}
      />
      {found === undefined ? <Text dimColor>  looking for more...</Text> : null}
    </Box>
  );
}

const QUESTION: Record<Exclude<Step, "pick">, string> = {
  name: "a name for it (e.g. openai, work): ",
  url: "endpoint URL: ",
  model: "model name (blank to decide later): ",
  key: "API key (blank if none): ",
};

function Field({
  step,
  draft,
  setDraft,
  onSubmit,
}: {
  step: Step;
  draft: string;
  setDraft: (v: string) => void;
  onSubmit: (v: string) => void;
}) {
  if (step === "pick") return null;
  return (
    <Box>
      <Text>{QUESTION[step]}</Text>
      <TextInput
        value={draft}
        onChange={setDraft}
        onSubmit={onSubmit}
        // A key typed in front of someone is a key to rotate.
        {...(step === "key" ? { mask: "•" } : {})}
      />
    </Box>
  );
}
