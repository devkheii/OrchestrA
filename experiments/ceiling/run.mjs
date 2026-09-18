import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { MODELS, LLAMA, PORT, SAMPLING } from "./models.mjs";

/**
 * Ask each model every task, batched by model.
 *
 * Resumable by design: every answer is appended to a per-model JSONL as soon
 * as it arrives, and a re-run skips task ids already present. A run of this is
 * hours long on one consumer GPU, and an interruption two hours in must not
 * cost two hours.
 */

const OUT = "results";
const TASKS = "data/tasks.jsonl";

const tasks = readFileSync(TASKS, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
mkdirSync(OUT, { recursive: true });

const only = process.argv[2];

for (const model of MODELS) {
  if (only && model.key !== only) continue;

  const outPath = join(OUT, `answers-${model.key}.jsonl`);
  const done = new Set(
    existsSync(outPath)
      ? readFileSync(outPath, "utf8")
          .split("\n").filter(Boolean).map((l) => JSON.parse(l))
          // An error is not an answer. README.md fixes that a failed request
          // is re-run rather than scored, so it does not count as done.
          .filter((r) => !r.error)
          .map((r) => r.id)
      : [],
  );
  const todo = tasks.filter((t) => !done.has(t.task_id));

  if (todo.length === 0) {
    console.log(`${model.key}: ${done.size} already answered, nothing to do`);
    continue;
  }
  console.log(`${model.key}: ${todo.length} to answer (${done.size} already done)`);

  const server = await startServer(model);
  const started = Date.now();

  try {
    for (const [i, task] of todo.entries()) {
      const at = Date.now();
      let record;
      try {
        const reply = await ask(model, task.prompt);
        record = { id: task.task_id, ...reply, ms: Date.now() - at };
      } catch (err) {
        // A failed request is recorded as a failed request, not as a wrong
        // answer. Scoring an infrastructure error as a model error would move
        // the exact cell this experiment measures.
        record = { id: task.task_id, error: String(err.message ?? err), ms: Date.now() - at };
      }
      appendFileSync(outPath, JSON.stringify(record) + "\n");

      const elapsed = (Date.now() - started) / 1000;
      const eta = ((elapsed / (i + 1)) * (todo.length - i - 1) / 60).toFixed(0);
      process.stdout.write(
        `\r  ${i + 1}/${todo.length}  ${(record.ms / 1000).toFixed(1)}s  eta ${eta}m   `,
      );
    }
  } finally {
    process.stdout.write("\n");
    await server.stop();
  }
}

async function ask(model, prompt) {
  // Streamed, and not for the progress display.
  //
  // A non-streamed request holds the connection open with no bytes until the
  // whole answer is ready, and node's fetch gives up at 300s. On this card
  // Gemma emits about 4.7 tok/s, so every task needing more than ~1,140 tokens
  // failed at a constant 307s -- 47 of 60 -- and that failure looked like the
  // model's, which is exactly the confusion the pre-registration forbids.
  // Streaming returns the headers immediately and the timeout never applies.
  const res = await fetch(`http://127.0.0.1:${PORT}/v1/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: model.key,
      messages: [
        {
          role: "user",
          content:
            `Complete the following Python function. Reply with the complete function, ` +
            `including its signature, in a single Python code block. No explanation.\n\n` +
            "```python\n" + prompt + "```",
        },
      ],
      max_tokens: model.maxTokens,
      stream: true,
      stream_options: { include_usage: true },
      ...SAMPLING,
    }),
  });

  if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);

  let answer = "";
  let reasoning = "";
  let finish = null;
  let usage = null;
  let buffer = "";

  const decoder = new TextDecoder();
  for await (const chunk of res.body) {
    buffer += decoder.decode(chunk, { stream: true });

    // SSE frames are separated by a blank line, and a chunk can split one in
    // half. Whatever follows the last separator stays in the buffer.
    const frames = buffer.split("\n\n");
    buffer = frames.pop() ?? "";

    for (const frame of frames) {
      const line = frame.split("\n").find((l) => l.startsWith("data:"));
      if (!line) continue;
      const payload = line.slice(5).trim();
      if (!payload || payload === "[DONE]") continue;

      const event = JSON.parse(payload);
      if (event.usage) usage = event.usage;

      const delta = event.choices?.[0]?.delta;
      if (delta?.content) answer += delta.content;
      // Its own accumulator, never appended to the answer. A reasoning model
      // that thinks in prose would otherwise have its thinking graded as code
      // (SPEC invariant 35 draws the same line for the same reason).
      if (delta?.reasoning_content) reasoning += delta.reasoning_content;

      const reason = event.choices?.[0]?.finish_reason;
      if (reason) finish = reason;
    }
  }

  return { answer, reasoning: reasoning || null, finish, usage };
}

async function startServer(model) {
  if (await listening()) throw new Error(`port ${PORT} is busy; stop what is on it first`);

  console.log(`  loading ${model.label} ${model.quant}`);
  const child = spawn(
    LLAMA,
    [
      "serve",
      "-m", model.path,
      "--port", String(PORT),
      "-c", String(model.contextSize),
      "-ngl", String(model.gpuLayers),
      "--no-warmup",
    ],
    { stdio: ["ignore", "pipe", "pipe"] },
  );

  let log = "";
  child.stdout.on("data", (d) => (log += d));
  child.stderr.on("data", (d) => (log += d));

  const failed = new Promise((_, reject) =>
    child.on("exit", (code) => reject(new Error(`llama exited ${code}:\n${log.slice(-2000)}`))),
  );

  const stop = async () => {
    spawn("taskkill", ["/pid", String(child.pid), "/t", "/f"], { stdio: "ignore" });
    // The next model cannot load until this one has released its VRAM, and
    // the port going quiet is the observable signal that it has.
    for (let i = 0; i < 120 && (await listening()); i++) await sleep(500);
    await sleep(2000);
  };

  try {
    await Promise.race([waitReady(), failed]);
  } catch (err) {
    // Tear down without letting cleanup replace the reason we are here. A
    // failure in stop() would otherwise hide why the server never came up.
    await stop().catch(() => {});
    throw err;
  }
  console.log(`  ready`);
  return { stop };
}

async function waitReady() {
  const deadline = Date.now() + 600_000;
  for (;;) {
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/v1/models`);
      if (res.ok) return;
    } catch {}
    if (Date.now() > deadline) throw new Error("model server did not become ready in 10 minutes");
    await sleep(1000);
  }
}

function listening() {
  return new Promise((resolve) => {
    const probe = createServer();
    probe.once("error", () => resolve(true));
    probe.once("listening", () => probe.close(() => resolve(false)));
    probe.listen(PORT, "127.0.0.1");
  });
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
