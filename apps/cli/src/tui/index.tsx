import { render } from "ink";
import { createElement } from "react";
import type { DaemonHandle } from "@dem/protocol";
import type { Settings } from "@dem/engine";
import { App } from "./app.js";
import { createDriver } from "./driver.js";

/**
 * Mounting the session.
 *
 * Kept separate from both the view and the driver so that `runInteractive`
 * stays a function the rest of the CLI can call without knowing a renderer is
 * involved, and so a headless caller can drive the same session without one.
 */

export async function runTui(
  daemon: DaemonHandle,
  settings: Settings,
  workspace: string,
  local: boolean,
  label: string,
  endpoint?: { baseUrl?: string | undefined; apiKey?: string | undefined } | undefined,
): Promise<number> {
  const driver = await createDriver({ daemon, settings, workspace, local, label, endpoint });

  const app = render(
    createElement(App, {
      initial: driver.state,
      subscribe: driver.subscribe,
      onSubmit: driver.submit,
      onAnswer: driver.answer,
      onCancel: driver.cancel,
    }),
    // Ink handles ctrl-c itself; letting it exit here rather than throwing
    // keeps a deliberate interrupt from looking like a crash.
    { exitOnCtrlC: true },
  );

  await app.waitUntilExit();
  return 0;
}
