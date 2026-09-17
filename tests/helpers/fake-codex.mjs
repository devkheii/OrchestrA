#!/usr/bin/env node
/**
 * A stand-in for the Codex CLI, emitting the same JSONL event shapes.
 *
 * Kept here for the same reason as the Claude stand-in: a real run spends the
 * user's account quota and takes tens of seconds, so a suite that called it
 * would compete with the person running it.
 *
 * Scenario is chosen by the prompt arriving on stdin.
 */

import { writeFile } from "node:fs/promises";
import { join } from "node:path";

const argv = process.argv.slice(2);
const emit = (msg) => process.stdout.write(JSON.stringify({ id: "0", msg }) + "\n");

let prompt = "";
process.stdin.on("data", (d) => (prompt += d.toString()));
process.stdin.on("end", async () => {
  // Working root, as the real CLI is told with -C.
  const cdIndex = argv.indexOf("-C");
  const workdir = cdIndex === -1 ? process.cwd() : argv[cdIndex + 1];

  // Recorded so a test can assert on the flags the adapter chose.
  emit({ type: "session_configured", argv });

  if (prompt.includes("SCENARIO_STALE_CLI")) {
    // The shape the real CLI produced when its model was too new for it:
    // retries, then a fatal error — while still exiting zero.
    emit({ type: "stream_error", message: "stream error: unexpected status 400; retrying 1/5" });
    emit({ type: "error", message: "The 'gpt-x' model requires a newer version of Codex." });
    process.exit(0);
  }

  if (prompt.includes("SCENARIO_NO_CHANGES")) {
    emit({ type: "agent_message", message: "Nothing needed changing." });
    process.exit(0);
  }

  if (prompt.includes("SCENARIO_CRASH")) {
    process.stderr.write("codex: panicked\n");
    process.exit(1);
  }

  await writeFile(join(workdir, "CODEX.md"), "written by codex\n", "utf8");
  emit({ type: "agent_message", message: "Created CODEX.md." });
  process.exit(0);
});
