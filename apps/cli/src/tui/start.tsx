import { useEffect, useState } from "react";
import { Box, Text, render } from "ink";
import SelectInput from "ink-select-input";
import { createElement } from "react";
import {
  discoverServers,
  discoverWeights,
  humanSize,
  labelForModels,
} from "@dem/engine";

/**
 * What `dem` shows before it connects to anything.
 *
 * It used to resolve whatever was configured and connect. When that endpoint
 * was unreachable the configuration check refused to open a session — which
 * was right, and left no way out, because the only thing that can change the
 * provider is `/provider`, which lives inside the session that would not open.
 * A gate that cannot be passed and cannot be reconfigured is a wall.
 *
 * Choosing first dissolves that: there is nothing to be locked out of. It also
 * matches what someone with several models actually wants, which is to decide
 * per session rather than to edit a file between sessions.
 */

export interface StartChoice {
  /** A configured provider name, or undefined for the flat configuration. */
  provider?: string | undefined;
  /** A discovered endpoint the user picked, to be written before connecting. */
  newEndpoint?: { baseUrl: string; model?: string | undefined } | undefined;
  /** The user asked for setup instead. */
  setup?: boolean;
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

export async function pickAtStart(options: StartOptions): Promise<StartChoice> {
  return new Promise((resolve) => {
    const app = render(
      createElement(Start, {
        ...options,
        onChoose: (choice: StartChoice) => {
          app.unmount();
          resolve(choice);
        },
      }),
      { exitOnCtrlC: true },
    );

    // Ctrl-C leaves without choosing rather than starting something.
    void app.waitUntilExit().then(() => resolve({ cancelled: true }));
  });
}

function Start({
  workspace,
  configured,
  flat,
  onChoose,
}: StartOptions & { onChoose: (choice: StartChoice) => void }) {
  const [found, setFound] = useState<Entry[] | undefined>(undefined);

  // Discovery runs while the configured entries are already on screen, so the
  // list is useful immediately and grows rather than making the user wait for
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
              },
            } as StartChoice,
          };
        }),
      ]);
      void labelForModels;
    })();
    return () => {
      live = false;
    };
  }, []);

  const entries: Entry[] = [
    ...configured.map((entry) => ({
      key: `cfg:${entry.name}`,
      label: `${entry.current ? "• " : "  "}${entry.name}   ${entry.detail}`,
      value: `cfg:${entry.name}`,
      choice: { provider: entry.name } as StartChoice,
    })),
    ...(flat && configured.length === 0
      ? [
          {
            key: "flat",
            label: `• ${flat.detail}`,
            value: "flat",
            choice: {} as StartChoice,
          },
        ]
      : []),
    ...(found ?? []),
    { key: "setup", label: "add a provider...", value: "setup", choice: { setup: true } },
  ];

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
          const entry = entries.find((e) => e.value === item.value);
          if (entry) onChoose(entry.choice);
        }}
      />
      {found === undefined ? (
        <Text dimColor>  looking for more on this machine...</Text>
      ) : null}
    </Box>
  );
}
