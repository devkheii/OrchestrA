import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Provider } from "@dem/protocol";

/**
 * Proving a model configuration works, before trusting it (invariant 44,
 * SPEC §25.3).
 *
 * This exists because of a measured failure. With a `q4_0` KV cache, a model
 * that scores 46 of 60 on HumanEval+ scored **0 of 60** on this machine — a
 * bare `from` inside a code fence, seven tokens, `finish_reason: stop`. The
 * published prior still said 78%, because a prior describes a model and a
 * weight is applied to a *deployment*.
 *
 * The check this replaces asked whether an answer came back within budget. The
 * broken configuration answered in 1.4 seconds. It measured whether the model
 * was alive, not whether it was right.
 *
 * What this is not: a benchmark. It does not rank models, it does not produce
 * a score anything is weighted by, and it cannot tell a good model from a
 * mediocre one. It answers one question — is this configuration broken — and
 * it has to stay cheap enough that every user can afford it, because §25.1
 * removed the requirement to run anything expensive. A check that costs
 * minutes is a check that gets disabled.
 */

export interface SmokeTask {
  id: string;
  prompt: string;
  /** Any of these appearing in the answer counts as correct. */
  expect: readonly string[];
}

/**
 * Deliberately trivial. Every one of these is something any working model
 * answers without thinking, which is what makes a total failure diagnostic:
 * it cannot mean "this model is weak", only "this configuration is broken".
 *
 * No generated code is executed. v0.1 ships no sandbox adapter (SPEC §19.1),
 * and a check that needs one is a check that cannot run in the place it is
 * most needed — a setup nobody has verified yet.
 */
export const SMOKE_TASKS: readonly SmokeTask[] = [
  {
    id: "arithmetic",
    prompt: "What is 17 + 25? Reply with only the number.",
    expect: ["42"],
  },
  {
    id: "echo",
    prompt: 'Reply with exactly this word and nothing else: banana',
    expect: ["banana"],
  },
  {
    id: "recall",
    prompt: "What is the capital city of France? Reply with only the city name.",
    expect: ["Paris"],
  },
  {
    id: "selection",
    prompt:
      "Consider this list: alpha, beta, gamma, delta. Reply with only the third item.",
    expect: ["gamma"],
  },
  {
    id: "counting",
    prompt: 'How many letters are in the word "hello"? Reply with only the number.',
    expect: ["5", "five"],
  },
];

/**
 * How many may fail before a configuration is judged broken.
 *
 * Not zero. A small quantized model can miss one of these, and a check that
 * refuses working setups gets turned off — at which point it protects nobody.
 * A broken configuration does not fail one of these, it fails all of them:
 * the q4 cache scored 0 of 5, and a GGUF with no chat template runs to the
 * token budget on every task.
 */
const TOLERATED_FAILURES = 1;

export interface SmokeConfig {
  /** Model identifier as configured. */
  model?: string | undefined;
  /** Path to the weights, when the harness serves them itself. */
  modelPath?: string | undefined;
  /** Server flags. `-ctk q4_0` lives here, which is why it is fingerprinted. */
  args?: readonly string[] | undefined;
}

export interface SmokeFailure {
  id: string;
  expected: readonly string[];
  /** What actually came back, so a corrupted cache is identifiable on sight. */
  got: string;
}

export interface SmokeResult {
  ok: boolean;
  passed: number;
  total: number;
  failures: readonly SmokeFailure[];
  /** Set when the result was read from cache rather than measured now. */
  cached?: boolean;
}

export interface SmokeOptions {
  config?: SmokeConfig;
  /** Where verdicts are cached. Omitted, nothing is written or read. */
  cacheDir?: string | undefined;
  /** Per-task ceiling. A task that needs longer than this is already wrong. */
  timeoutMs?: number;
}

/**
 * Identity of a configuration, not of a model.
 *
 * Keyed on the server flags as well as the weights, because that is exactly
 * where the measured breakage lived: same model file, same quantization, one
 * extra flag, and the score went from 46/60 to 0/60. A cache keyed on the
 * model alone would carry the old verdict straight past the thing that broke
 * it.
 */
export function configFingerprint(config: SmokeConfig): string {
  const canonical = JSON.stringify({
    model: config.model ?? "",
    modelPath: config.modelPath ?? "",
    args: [...(config.args ?? [])],
  });
  return createHash("sha256").update(canonical).digest("hex").slice(0, 16);
}

/** A previously recorded verdict for this configuration, if there is one. */
export async function readSmokeResult(
  config: SmokeConfig,
  cacheDir: string,
): Promise<SmokeResult | undefined> {
  try {
    const text = await readFile(cachePath(config, cacheDir), "utf8");
    return { ...(JSON.parse(text) as SmokeResult), cached: true };
  } catch {
    // No verdict, an unreadable one, or a directory that does not exist. All
    // three mean the same thing here: measure it.
    return undefined;
  }
}

export async function runSmokeTest(
  provider: Provider,
  options: SmokeOptions = {},
): Promise<SmokeResult> {
  if (options.config && options.cacheDir) {
    const cached = await readSmokeResult(options.config, options.cacheDir);
    if (cached) return cached;
  }

  const failures: SmokeFailure[] = [];
  let passed = 0;

  for (const task of SMOKE_TASKS) {
    const answer = await ask(provider, task.prompt, options.timeoutMs ?? 60_000);

    if (answer.ok && matches(answer.text, task.expect)) {
      passed++;
      continue;
    }
    failures.push({
      id: task.id,
      expected: task.expect,
      // Trimmed, because this is shown to a person and a broken model can
      // produce a great deal of nothing.
      got: answer.text.slice(0, 200).trim() || `<${answer.reason}>`,
    });
  }

  const result: SmokeResult = {
    ok: failures.length <= TOLERATED_FAILURES,
    passed,
    total: SMOKE_TASKS.length,
    failures,
  };

  if (options.config && options.cacheDir) {
    // A failure is cached too. Re-running a broken configuration every session
    // spends the user's time to re-learn something already known, and the fix
    // is a config change, which changes the fingerprint and re-runs this
    // anyway.
    await write(options.config, options.cacheDir, result);
  }

  return result;
}

/** A sentence a person can act on, rather than "the smoke test failed". */
export function explainSmokeFailure(result: SmokeResult, config: SmokeConfig): string {
  const lines = [
    `this model configuration answered ${result.passed} of ${result.total} trivial questions correctly, ` +
      `so it is not working (SPEC §25.3).`,
  ];

  for (const failure of result.failures.slice(0, 3)) {
    lines.push(`  ${failure.id}: expected ${failure.expected.join(" or ")}, got ${failure.got}`);
  }

  // The two breakages actually seen, named, because both look like a model
  // problem and neither is.
  if (config.args?.some((a) => /^q[45]_/.test(a))) {
    lines.push(
      `  A quantized KV cache is configured. A q4_0 cache took a model from 46/60 to 0/60 ` +
        `on the reference machine; q8_0 cost nothing. Try -ctk q8_0 -ctv q8_0.`,
    );
  }
  lines.push(
    `  If the answers ran on and on rather than being wrong, the weights may carry no chat ` +
      `template, so the server cannot tell when the model has stopped.`,
  );

  return lines.join("\n");
}

function matches(text: string, expected: readonly string[]): boolean {
  // Substring, not equality. A working model may answer "The answer is 42."
  // and refusing that would fail healthy setups, which is the failure mode
  // that gets a check disabled.
  const haystack = text.toLowerCase();
  return expected.some((e) => haystack.includes(e.toLowerCase()));
}

async function ask(
  provider: Provider,
  prompt: string,
  timeoutMs: number,
): Promise<{ ok: boolean; text: string; reason: string }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  let text = "";
  try {
    for await (const event of provider.run(
      {
        messages: [{ role: "user", content: prompt }],
        // Enough for a word or a number and the wrapping around it. A model
        // that needs more than this for "17 + 25" is telling us something.
        maxOutputTokens: 256,
        temperature: 0,
      },
      { signal: controller.signal },
    )) {
      if (event.type === "delta") text += event.text;
      else if (event.type === "error") return { ok: false, text, reason: event.message };
      else if (event.type === "done") {
        // Running to the budget on a one-word question is the signature of a
        // model whose stop token the server does not recognise. It produced
        // text, so a liveness probe would have passed it.
        return { ok: event.reason === "stop", text, reason: event.reason };
      }
      // A rationale event is deliberately ignored rather than concatenated:
      // reasoning is not an answer (invariant 35).
    }
    return { ok: false, text, reason: "ended without finishing" };
  } catch (err) {
    return { ok: false, text, reason: (err as Error).message };
  } finally {
    clearTimeout(timer);
  }
}

function cachePath(config: SmokeConfig, cacheDir: string): string {
  return join(cacheDir, "smoke", `${configFingerprint(config)}.json`);
}

async function write(
  config: SmokeConfig,
  cacheDir: string,
  result: SmokeResult,
): Promise<void> {
  try {
    await mkdir(join(cacheDir, "smoke"), { recursive: true });
    await writeFile(cachePath(config, cacheDir), JSON.stringify(result, null, 2));
  } catch {
    // An unwritable cache costs a few seconds next time. Refusing to check
    // because the verdict cannot be saved would skip the check on exactly the
    // setups least likely to be healthy.
  }
}
