import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

/**
 * Grading: does this candidate solution pass the task's tests?
 *
 * Model-generated code is executed, so it runs in a container with no network,
 * no privileges and a dropped filesystem — not in a subprocess on this machine.
 * SPEC §8.4 requires exactly this of counterexample execution and there is no
 * reason the experiment that decides whether to build that should be held to a
 * looser standard than the thing it decides about.
 *
 * One container for a whole batch, with each program as its own subprocess
 * inside it: per-task containers cost 1.8s each, which is 10 minutes of pure
 * overhead across a run and buys isolation the subprocess already provides.
 */

const here = dirname(fileURLToPath(import.meta.url));
export const GRADER_IMAGE = "dem-grader";

/** @param {{id: string, program: string}[]} programs */
export async function gradeBatch(programs) {
  const inner = readFileSync(join(here, "grade_inner.py"), "utf8");

  const child = spawn(
    "docker",
    [
      "run", "-i", "--rm",
      "--network", "none",
      "--memory", "3g",
      "--pids-limit", "256",
      "--cap-drop", "ALL",
      "--security-opt", "no-new-privileges",
      GRADER_IMAGE,
      "python", "-c", inner,
    ],
    { stdio: ["pipe", "pipe", "pipe"] },
  );

  let out = "";
  let err = "";
  child.stdout.on("data", (d) => (out += d));
  child.stderr.on("data", (d) => (err += d));

  for (const program of programs) child.stdin.write(JSON.stringify(program) + "\n");
  child.stdin.end();

  const code = await new Promise((resolve) => child.on("close", resolve));

  const verdicts = out
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l));

  // A batch that returns fewer verdicts than programs has lost results
  // silently, and a missing verdict read as a failure would bias the very cell
  // this experiment measures. Refuse rather than under-report.
  if (verdicts.length !== programs.length) {
    throw new Error(
      `grading returned ${verdicts.length} verdicts for ${programs.length} programs ` +
        `(docker exit ${code})\n${err.slice(-1000)}`,
    );
  }
  return verdicts;
}
