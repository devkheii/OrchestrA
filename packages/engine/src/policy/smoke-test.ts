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
  /**
   * The endpoint. Fingerprinted because pointing at a different server is a
   * different deployment — and because leaving it out meant a verdict about
   * one endpoint was served for another.
   */
  baseUrl?: string | undefined;
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
  /**
   * Whether the model answered at all.
   *
   * A wrong answer is a verdict about the configuration. No answer is a
   * verdict about nothing, and the two have different fixes: one replaces
   * weights, the other waits for a server.
   */
  answered: boolean;
}

export interface SmokeResult {
  ok: boolean;
  passed: number;
  total: number;
  failures: readonly SmokeFailure[];
  /**
   * Nothing answered, so nothing was measured.
   *
   * The rule that caught four instrument failures in the efficacy experiment:
   * a failed request is not a wrong answer. Here it reached the user as "your
   * model answered 0 of 5 trivial questions" while a local server was still
   * loading its weights.
   */
  unreachable: boolean;
  /**
   * Whether a tool offered to this configuration comes back as a call.
   *
   * Undefined when it was not asked. An adapter cannot answer this from its
   * own class: with an OpenAI-compatible endpoint it depends on the server and
   * on the chat template inside the weights, and llama.cpp serving a GGUF
   * whose template has no tool section accepts the field and ignores it.
   */
  toolCalling?: boolean;
  /** Set when the result was read from cache rather than measured now. */
  cached?: boolean;
}

export interface SmokeOptions {
  config?: SmokeConfig;
  /** Also ask whether this configuration can call a tool (invariant 41). */
  probeTools?: boolean;
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
    baseUrl: config.baseUrl ?? "",
    modelPath: config.modelPath ?? "",
    args: [...(config.args ?? [])],
    // A verdict is about a configuration *and* the code that judged it. A bug
    // in this harness once made every endpoint answer 404, and the cached
    // "not working" outlived the fix — so a user who upgraded would keep being
    // told their working setup was broken. Bump this when the outcome of the
    // check could change for reasons that are ours rather than theirs.
    checker: CHECKER_VERSION,
  });
  return createHash("sha256").update(canonical).digest("hex").slice(0, 16);
}

/** Raised when a harness change could alter a verdict. See above. */
const CHECKER_VERSION = 2;

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


/**
 * Can this configuration actually call a tool?
 *
 * Invariant 41 ends "a provider that cannot call tools is told so and is
 * offered none", and the harness was doing the opposite: offering tools to a
 * local model whose template cannot express them, which made the model write
 * a call as text and the guard refuse it. Every message came back a refusal.
 *
 * One trivial tool, offered once. A model that answers in prose has not called
 * anything, and neither has one that writes a call-shaped object into its
 * answer — that is the fabrication invariant 41 exists for.
 */
export async function probeToolCalling(provider: Provider): Promise<boolean> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 60_000);

  try {
    for await (const event of provider.run(
      {
        messages: [
          {
            role: "user",
            content: "Call the `probe` tool. Do not answer in text.",
          },
        ],
        tools: [
          {
            name: "probe",
            description: "A tool that exists only to see whether tools can be called.",
            parameters: { type: "object", properties: {}, additionalProperties: false },
          },
        ],
        maxOutputTokens: 128,
        temperature: 0,
      },
      { signal: controller.signal },
    )) {
      if (event.type === "tool_call") return true;
      if (event.type === "error") return false;
    }
    return false;
  } catch {
    // Unreachable, refused, or timed out. Not a claim that tools work.
    return false;
  } finally {
    clearTimeout(timer);
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
      answered: answer.text.trim().length > 0,
    });
  }

  // Nothing came back at all: the server was down, still loading, or behind
  // something that refused. That is not a measurement of this model.
  const unreachable = passed === 0 && failures.every((f) => !f.answered);

  const result: SmokeResult = {
    ok: failures.length <= TOLERATED_FAILURES,
    passed,
    total: SMOKE_TASKS.length,
    failures,
    unreachable,
    // Asked here so it is asked once, cached with everything else about this
    // configuration, and re-asked when any of it changes.
    ...(options.probeTools && !unreachable
      ? { toolCalling: await probeToolCalling(provider) }
      : {}),
  };

  if (options.config && options.cacheDir && !unreachable) {
    // A wrong answer is cached, because re-running a broken configuration
    // every session spends the user's time to re-learn something already
    // known, and the fix is a config change, which changes the fingerprint.
    //
    // A non-answer is not, because caching it turns a server that was briefly
    // unavailable into a permanent verdict about weights that were fine.
    await write(options.config, options.cacheDir, result);
  }

  return result;
}

/** A sentence a person can act on, rather than "the smoke test failed". */
export function explainSmokeFailure(result: SmokeResult, config: SmokeConfig): string {
  if (result.unreachable) {
    // A different problem with a different fix. Telling someone their model is
    // broken when the server was not up sends them to replace weights that
    // were fine.
    return [
      `could not get an answer out of this model at all, so it has not been checked.`,
      ...result.failures.slice(0, 2).map((f) => `  ${f.id}: ${f.got}`),
      `  The server may still be starting, or may not be running.`,
    ].join("\n");
  }

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
