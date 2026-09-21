import { describe, expect, it } from "vitest";
import { join } from "node:path";
import { CAP_TEXT_GENERATE } from "@dem/protocol";
import type { ModelEvent, ModelRequest, Provider, ProviderHealth } from "@dem/protocol";
import { SMOKE_TASKS, configFingerprint, readSmokeResult, runSmokeTest } from "@dem/engine";
import { withTempDir } from "../helpers/temp.js";

/**
 * ORCH-008 — a configuration is proved working before it is trusted
 * (invariant 44, SPEC §25.3).
 *
 * This exists because of a measured failure, not a hypothetical one. With a
 * `q4_0` KV cache, a model that scores 46 of 60 scored 0 of 60, answering a
 * bare `from` inside a code fence in seven tokens and reporting
 * `finish_reason: stop`. The published prior still said 78%. The fit probe
 * this replaces asked only whether an answer came back within budget, and the
 * broken configuration answered in 1.4 seconds.
 *
 * So the check has to be about correctness, and it has to be cheap enough that
 * every user can afford it — which is the line between this and a benchmark.
 */

/** Answers each prompt from a lookup, so a test can script exactly one wrong. */
function scripted(answers: (prompt: string) => string): Provider {
  return {
    id: "scripted",
    capabilities: () => [CAP_TEXT_GENERATE],
    async *run(request: ModelRequest): AsyncIterable<ModelEvent> {
      const prompt = request.messages.at(-1)?.content ?? "";
      yield { type: "delta", text: answers(prompt) };
      yield { type: "done", reason: "stop" };
    },
    health: async (): Promise<ProviderHealth> => ({ ok: true, detail: "scripted" }),
  };
}

/** A provider answering every task correctly, by consulting the expected answer. */
const healthy = scripted((prompt) => {
  const task = SMOKE_TASKS.find((t) => t.prompt === prompt);
  return task ? task.expect[0]! : "?";
});

/** What the q4_0 cache actually produced: a few tokens of nothing, then stop. */
const broken = scripted(() => "```python\nfrom\n```");

describe("A working configuration passes", () => {
  it("accepts a provider that answers the known-answer tasks", async () => {
    const result = await runSmokeTest(healthy);
    expect(result.ok).toBe(true);
    expect(result.passed).toBe(SMOKE_TASKS.length);
  });

  it("tolerates ordinary wrapping rather than demanding an exact string", async () => {
    // A working model may answer "The answer is 42." A check that fails that
    // would refuse working setups, and a check that cries wolf gets disabled.
    const chatty = scripted((prompt) => {
      const task = SMOKE_TASKS.find((t) => t.prompt === prompt);
      return `Sure! The answer is **${task ? task.expect[0] : "?"}**.`;
    });
    const result = await runSmokeTest(chatty);
    expect(result.ok).toBe(true);
  });

  it("still passes when one task fails, because a weak model is not a broken one", async () => {
    // The question is "is this configuration broken", not "is this model good".
    // Failing one trivial task is what a small model does; failing all of them
    // is what a corrupted cache does.
    let seen = 0;
    const nearlyRight = scripted((prompt) => {
      const task = SMOKE_TASKS.find((t) => t.prompt === prompt);
      return seen++ === 0 ? "no idea" : task ? task.expect[0]! : "?";
    });
    const result = await runSmokeTest(nearlyRight);
    expect(result.ok).toBe(true);
    expect(result.passed).toBe(SMOKE_TASKS.length - 1);
  });
});

describe("A broken configuration is caught", () => {
  it("rejects the q4_0 failure mode, which answers fast and wrongly", async () => {
    const result = await runSmokeTest(broken);
    expect(result.ok).toBe(false);
    expect(result.passed).toBe(0);
  });

  it("names a failing task and what came back, so the user can tell what broke", async () => {
    // "Your configuration failed" sends someone to the wrong place. The answer
    // it actually produced is what identifies a corrupted cache or a wrong
    // chat template on sight.
    const result = await runSmokeTest(broken);
    expect(result.failures.length).toBeGreaterThan(0);
    expect(result.failures[0]!.got).toContain("from");
    expect(result.failures[0]!.expected.length).toBeGreaterThan(0);
  });

  it("treats a truncated answer as a failure", async () => {
    // The other measured breakage: a GGUF with no chat template never emits a
    // stop token and runs to the budget. It produces text, so a liveness probe
    // passes it.
    const runsOn: Provider = {
      id: "runs-on",
      capabilities: () => [CAP_TEXT_GENERATE],
      async *run(): AsyncIterable<ModelEvent> {
        yield { type: "delta", text: "Sure, here is my answer and then I keep going" };
        yield { type: "done", reason: "length" };
      },
      health: async () => ({ ok: true, detail: "" }),
    };
    const result = await runSmokeTest(runsOn);
    expect(result.ok).toBe(false);
  });

  it("treats a provider error as a failure rather than letting it through", async () => {
    const failing: Provider = {
      id: "failing",
      capabilities: () => [CAP_TEXT_GENERATE],
      async *run(): AsyncIterable<ModelEvent> {
        yield { type: "error", message: "connection refused" };
      },
      health: async () => ({ ok: false, detail: "down" }),
    };
    const result = await runSmokeTest(failing);
    expect(result.ok).toBe(false);
  });
});

describe("The result is cached by configuration, not by session", () => {
  it("does not re-run for the same configuration", async () => {
    await withTempDir(async (dir) => {
      let calls = 0;
      const counting = scripted((prompt) => {
        calls++;
        const task = SMOKE_TASKS.find((t) => t.prompt === prompt);
        return task ? task.expect[0]! : "?";
      });
      const config = { model: "qwen", modelPath: "/m.gguf", args: ["-fa", "on"] };

      await runSmokeTest(counting, { config, cacheDir: dir });
      const afterFirst = calls;
      await runSmokeTest(counting, { config, cacheDir: dir });

      expect(calls).toBe(afterFirst);
      expect(afterFirst).toBe(SMOKE_TASKS.length);
    });
  });

  it("re-runs when a server flag changes, because that is what broke the model", async () => {
    // The whole point: `-ctk q4_0` is a server flag, and adding it turned a
    // 46/60 model into a 0/60 one. A cache keyed on the model alone would
    // carry the old verdict straight past it.
    await withTempDir(async (dir) => {
      let calls = 0;
      const counting = scripted((prompt) => {
        calls++;
        const task = SMOKE_TASKS.find((t) => t.prompt === prompt);
        return task ? task.expect[0]! : "?";
      });

      await runSmokeTest(counting, {
        config: { model: "qwen", modelPath: "/m.gguf", args: ["-fa", "on"] },
        cacheDir: dir,
      });
      const afterFirst = calls;

      await runSmokeTest(counting, {
        config: { model: "qwen", modelPath: "/m.gguf", args: ["-fa", "on", "-ctk", "q4_0"] },
        cacheDir: dir,
      });

      expect(calls).toBe(afterFirst * 2);
    });
  });

  it("gives different fingerprints to configurations that differ anywhere", () => {
    const base = { model: "qwen", modelPath: "/m.gguf", args: ["-fa", "on"] };
    const seen = new Set([
      configFingerprint(base),
      configFingerprint({ ...base, model: "deepseek" }),
      configFingerprint({ ...base, modelPath: "/other.gguf" }),
      configFingerprint({ ...base, args: ["-fa", "on", "-ctk", "q4_0"] }),
    ]);
    expect(seen.size).toBe(4);
  });

  it("caches a failure too, so a broken setup is not retried every run", async () => {
    await withTempDir(async (dir) => {
      const config = { model: "qwen", modelPath: "/m.gguf", args: ["-ctk", "q4_0"] };
      const first = await runSmokeTest(broken, { config, cacheDir: dir });
      expect(first.ok).toBe(false);

      const cached = await readSmokeResult(config, dir);
      expect(cached?.ok).toBe(false);
      expect(cached?.failures.length).toBeGreaterThan(0);
    });
  });

  it("works with no cache directory at all, rather than refusing to check", async () => {
    // A check that needs somewhere to write is a check that gets skipped on
    // the setups least likely to be healthy.
    const result = await runSmokeTest(healthy, {
      config: { model: "qwen", modelPath: "/m.gguf", args: [] },
      cacheDir: join("/definitely", "not", "writable", "anywhere"),
    });
    expect(result.ok).toBe(true);
  });
});

describe("The tasks themselves", () => {
  it("are few enough to be free and answerable without a sandbox", () => {
    // If this grows into a benchmark it stops being run. It exists to be
    // cheap; `docs/SPEC.md` §25.3 draws the line.
    expect(SMOKE_TASKS.length).toBeGreaterThanOrEqual(4);
    expect(SMOKE_TASKS.length).toBeLessThanOrEqual(8);
    for (const task of SMOKE_TASKS) {
      expect(task.expect.length).toBeGreaterThan(0);
      // No generated code is executed: v0.1 ships no sandbox, and a check that
      // needs one is a check that cannot run where it is needed most.
      expect(task.prompt).not.toMatch(/```/);
    }
  });
});

describe("Scope: what gets checked and what does not", () => {
  it("passes a provider whose answers are wrapped in explanation", async () => {
    // Restated deliberately. The check must not fail a working model, because
    // a check that fails working models is a check the next user disables, and
    // then it is not there for the one whose cache is corrupted.
    const verbose = scripted((prompt) => {
      const task = SMOKE_TASKS.find((t) => t.prompt === prompt);
      return [
        "Let me think about this step by step.",
        `The answer is ${task ? task.expect[0] : "?"}.`,
        "Let me know if you need anything else!",
      ].join("\n");
    });
    expect((await runSmokeTest(verbose)).ok).toBe(true);
  });

  it("does not treat a rationale channel as the answer", async () => {
    // Invariant 35: reasoning is not an answer. A model whose rationale
    // contains the right number but whose answer is empty has not answered,
    // and concatenating the two would score it as if it had.
    const thinksOnly: Provider = {
      id: "thinks-only",
      capabilities: () => [CAP_TEXT_GENERATE],
      async *run(): AsyncIterable<ModelEvent> {
        yield { type: "rationale", text: "42 banana Paris gamma 5" };
        yield { type: "delta", text: "" };
        yield { type: "done", reason: "stop" };
      },
      health: async () => ({ ok: true, detail: "" }),
    };
    expect((await runSmokeTest(thinksOnly)).ok).toBe(false);
  });
});

describe("A failed request is not a wrong answer", () => {
  /**
   * The rule that caught four instrument failures in the efficacy experiment,
   * arriving in the product the third time it was needed here.
   *
   * `dem` started a local server, the smoke test fired while the weights were
   * still loading, every question came back 503, and the verdict "your model
   * answered 0 of 5" was written to the cache. The launcher's impatience was
   * then reported as the model's fault on every subsequent run, including
   * after it was fixed.
   */
  const unreachable: Provider = {
    id: "unreachable",
    capabilities: () => [CAP_TEXT_GENERATE],
    async *run(): AsyncIterable<ModelEvent> {
      yield { type: "error", message: "endpoint returned 503" };
    },
    health: async () => ({ ok: false, detail: "loading" }),
  };

  it("does not record a verdict when nothing ever answered", async () => {
    await withTempDir(async (dir) => {
      const config = { model: "m", baseUrl: "http://127.0.0.1:1" };
      const result = await runSmokeTest(unreachable, { config, cacheDir: dir });

      expect(result.ok).toBe(false);
      // Not measured, so nothing to remember. The next run tries again rather
      // than repeating a conclusion it never actually reached.
      expect(await readSmokeResult(config, dir)).toBeUndefined();
    });
  });

  it("still records a verdict when the model answered and was wrong", async () => {
    await withTempDir(async (dir) => {
      const config = { model: "m", baseUrl: "http://127.0.0.1:1" };
      await runSmokeTest(broken, { config, cacheDir: dir });
      expect((await readSmokeResult(config, dir))?.ok).toBe(false);
    });
  });

  it("says it could not reach the model, rather than that the model is wrong", async () => {
    // Two different problems with two different fixes. Telling someone their
    // model is broken when the server was not up sends them to replace weights
    // that were fine.
    const result = await runSmokeTest(unreachable);
    expect(result.unreachable).toBe(true);
  });

  it("treats a wrong answer as measured even if one task also errored", async () => {
    // A single transport hiccup among real answers is not grounds to discard
    // what the other four said.
    let n = 0;
    const mostly: Provider = {
      id: "mostly",
      capabilities: () => [CAP_TEXT_GENERATE],
      async *run(): AsyncIterable<ModelEvent> {
        if (n++ === 0) {
          yield { type: "error", message: "transient" };
          return;
        }
        yield { type: "delta", text: "nonsense" };
        yield { type: "done", reason: "stop" };
      },
      health: async () => ({ ok: true, detail: "" }),
    };
    const result = await runSmokeTest(mostly);
    expect(result.unreachable).toBe(false);
    expect(result.ok).toBe(false);
  });
});
