#!/usr/bin/env node
/**
 * A stand-in for the Codex CLI.
 *
 * Kept for the same reason as the Claude stand-in: a real run spends the
 * user's account quota and takes tens of seconds, so a suite that called it
 * would compete with the person running it.
 *
 * **Both event vocabularies are emitted, because the CLI changed one.** An
 * earlier version of this file encoded only the pre-0.40 shape, taken from a
 * single observation. The tests passed while the adapter could not parse what
 * the installed CLI actually produced — a stand-in built from a stale
 * observation validates the stand-in, not the adapter. The scenarios below
 * are transcribed from real output of both versions.
 *
 * Scenario is chosen by the prompt arriving on stdin.
 */

import { writeFile } from "node:fs/promises";
import { join } from "node:path";

const argv = process.argv.slice(2);
const emit = (obj) => process.stdout.write(JSON.stringify(obj) + "\n");

/** Pre-0.40 wrapped every frame in `msg`. */
const emitLegacy = (msg) => emit({ id: "0", msg });

let prompt = "";
process.stdin.on("data", (d) => (prompt += d.toString()));
process.stdin.on("end", async () => {
  const cdIndex = argv.indexOf("-C");
  const workdir = cdIndex === -1 ? process.cwd() : argv[cdIndex + 1];

  // Recorded so a test can assert on the flags the adapter chose.
  emit({ type: "session_configured", argv });

  if (prompt.includes("SCENARIO_LEGACY_ERROR")) {
    // 0.40: retries, then a fatal error, then exit 0.
    emitLegacy({ type: "stream_error", message: "stream error: unexpected status 400; retrying 1/5" });
    emitLegacy({ type: "error", message: "The 'gpt-x' model requires a newer version of Codex." });
    process.exit(0);
  }

  if (prompt.includes("SCENARIO_TURN_FAILED")) {
    // 0.154: a rejected model. Note the exit code.
    emit({ type: "turn.started" });
    emit({ type: "error", message: '{"status":400,"error":{"message":"model is not supported"}}' });
    emit({ type: "turn.failed", error: { message: "model is not supported" } });
    process.exit(0);
  }

  if (prompt.includes("SCENARIO_ITEM_WARNING")) {
    // An item-level error that is a warning: the run goes on to succeed.
    emit({
      type: "item.completed",
      item: {
        id: "item_0",
        type: "error",
        message: "Model metadata not found. Defaulting to fallback metadata.",
      },
    });
    emit({ type: "turn.started" });
    await writeFile(join(workdir, "CODEX.md"), "written by codex\n", "utf8");
    emit({ type: "item.completed", item: { type: "agent_message", text: "Created CODEX.md." } });
    emit({ type: "turn.completed", usage: { input_tokens: 10, output_tokens: 5 } });
    process.exit(0);
  }

  if (prompt.includes("SCENARIO_NO_CHANGES")) {
    emit({ type: "turn.started" });
    emit({ type: "item.completed", item: { type: "agent_message", text: "Nothing needed changing." } });
    emit({ type: "turn.completed", usage: {} });
    process.exit(0);
  }

  if (prompt.includes("SCENARIO_CRASH")) {
    process.stderr.write("codex: panicked\n");
    process.exit(1);
  }

  emit({ type: "turn.started" });
  await writeFile(join(workdir, "CODEX.md"), "written by codex\n", "utf8");
  emit({ type: "item.completed", item: { type: "agent_message", text: "Created CODEX.md." } });
  emit({ type: "turn.completed", usage: { input_tokens: 10, output_tokens: 5 } });
  process.exit(0);
});
