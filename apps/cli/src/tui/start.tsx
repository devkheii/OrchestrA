import { createElement, useEffect, useState } from "react";
import { Box, Text, render } from "ink";
import SelectInput from "ink-select-input";
import { discoverServers, discoverWeights, humanSize } from "@dem/engine";
import { Configure, type ConfiguredProvider } from "./configure.js";

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

/**
 * A provider the user configured here.
 *
 * Replaces a four-question form that only knew how to describe an
 * OpenAI-compatible endpoint. What is asked now depends on the runtime
 * (SPEC 33.5), which is the thing that decides what the answers mean.
 */
export type ManualProvider = ConfiguredProvider;

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

function Start({
  workspace,
  configured,
  flat,
  onChoose,
}: StartOptions & { onChoose: (choice: StartChoice) => void }) {
  const [found, setFound] = useState<Entry[] | undefined>(undefined);
  const [weights, setWeights] = useState<Array<{ label: string; path: string }>>([]);
  const [adding, setAdding] = useState(false);

  // Discovery runs while the configured entries are already on screen, so the
  // list is useful immediately and grows, rather than making someone wait for
  // a scan of a machine that may have nothing on it.
  useEffect(() => {
    let live = true;
    void (async () => {
      const [servers, weights] = await Promise.all([discoverServers(), discoverWeights()]);
      if (!live) return;

      setWeights(
        weights.slice(0, 8).map((w) => ({
          label: `${w.path.split(/[\/]/).pop() ?? w.path}  ${humanSize(w.sizeBytes)}`,
          path: w.path,
        })),
      );

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

  if (adding) {
    return (
      <Box flexDirection="column">
        <Box marginBottom={1}>
          <Text bold>dem</Text>
          <Text dimColor>  adding a provider</Text>
        </Box>
        <Configure
          weights={weights}
          onCancel={() => onChoose({ cancelled: true })}
          onDone={(provider) => onChoose({ manual: provider })}
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
            setAdding(true);
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
