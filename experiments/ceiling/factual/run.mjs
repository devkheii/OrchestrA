import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { readCredential } from "../credentials.mjs";
import { ALL, LLAMA, PORT, SAMPLING } from "../models.mjs";
import { spawn } from "node:child_process";
import { createServer } from "node:net";

/**
 * Ask each model every factual question, batched by model.
 *
 * Separate from the code runner rather than a flag on it: the prompt, the
 * answer shape and what counts as a refusal are all different, and threading
 * two task types through one script would make each harder to read than both.
 * What is shared — the credential store, the model definitions, the streaming
 * and the resume rule — is imported rather than copied.
 */

const OUT = process.env["DEM_RESULTS_DIR"] ?? "factual/results";
const TASKS = "factual/tasks.jsonl";

const tasks = readFileSync(TASKS, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
mkdirSync(OUT, { recursive: true });

const named = process.argv.slice(2).filter((a) => !a.startsWith("-"));
const selected = named.map((key) => {
  const model = ALL[key];
  if (!model) throw new Error(`unknown model "${key}"; known: ${Object.keys(ALL).join(", ")}`);
  return model;
});
if (selected.length === 0) throw new Error("name at least one model");

/**
 * Short answers, asked for plainly.
 *
 * "I don't know" is offered explicitly because validity condition 5 needs
 * refusals to be distinguishable. A model with no option but to guess produces
 * a guess, and two guesses that happen to differ look like a working detector
 * while two that happen to match look like false consensus. Neither is true.
 */
const prompt = (question) =>
  `Answer this question with just the answer — a name, a word, or a short phrase. ` +
  `No sentence, no explanation. If you do not know, reply exactly: UNKNOWN\n\n${question}`;

for (const model of selected) {
  const outPath = join(OUT, `answers-${model.key}.jsonl`);
  const done = new Set(
    existsSync(outPath)
      ? readFileSync(outPath, "utf8")
          .split("\n").filter(Boolean).map((l) => JSON.parse(l))
          // An error is not an answer; it is re-run rather than scored.
          .filter((r) => !r.error)
          .map((r) => r.id)
      : [],
  );
  const todo = tasks.filter((t) => !done.has(t.id));

  if (todo.length === 0) {
    console.log(`${model.key}: ${done.size} already answered`);
    continue;
  }
  console.log(`${model.key}: ${todo.length} to answer (${done.size} done)`);

  const server = model.remote ? { stop: async () => {} } : await startServer(model);
  const started = Date.now();

  try {
    for (const [i, task] of todo.entries()) {
      const at = Date.now();
      let record;
      try {
        record = { id: task.id, ...(await ask(model, task.question)), ms: Date.now() - at };
      } catch (err) {
        let message = String(err.message ?? err);
        for (const secret of await knownSecrets(selected)) {
          if (secret.length > 8) message = message.split(secret).join("<redacted>");
        }
        record = { id: task.id, error: message, ms: Date.now() - at };
      }
      appendFileSync(outPath, JSON.stringify(record) + "\n");

      const elapsed = (Date.now() - started) / 1000;
      const eta = ((elapsed / (i + 1)) * (todo.length - i - 1) / 60).toFixed(0);
      process.stdout.write(`\r  ${i + 1}/${todo.length}  ${(record.ms / 1000).toFixed(1)}s  eta ${eta}m   `);
    }
  } finally {
    process.stdout.write("\n");
    await server.stop();
  }
}

async function ask(model, question) {
  const res = await fetch(chatUrl(model), {
    method: "POST",
    headers: await authHeaders(model),
    body: JSON.stringify({
      model: model.remoteModel ?? model.key,
      messages: [{ role: "user", content: prompt(question) }],
      // A name or a short phrase. A budget large enough for an essay invites
      // one, and an essay is not an answer this can compare.
      max_tokens: 64,
      stream: true,
      stream_options: { include_usage: true },
      ...SAMPLING,
      ...(model.extraBody ?? {}),
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
      if (delta?.reasoning_content) reasoning += delta.reasoning_content;
      const reason = event.choices?.[0]?.finish_reason;
      if (reason) finish = reason;
    }
  }

  // A stream that stopped is not a stream that finished (invariant 45).
  if (finish === null) {
    throw new Error(
      `stream ended without a finish reason after ${answer.length} chars — the server likely died`,
    );
  }

  return { answer, reasoning: reasoning || null, finish, usage };
}

function chatUrl(model) {
  const base = (model.baseUrl ?? `http://127.0.0.1:${PORT}`).replace(/\/+$/, "");
  return /\/v\d+$/.test(base) ? `${base}/chat/completions` : `${base}/v1/chat/completions`;
}

async function authHeaders(model) {
  const headers = { "content-type": "application/json" };
  if (!model.credential) return headers;
  const key = await readCredential(model.credential);
  if (!key) throw new Error(`${model.key} needs: dem auth add ${model.credential}`);
  headers["authorization"] = `Bearer ${key}`;
  return headers;
}

async function knownSecrets(models) {
  const out = [];
  for (const model of models) {
    if (model.credential) {
      const value = await readCredential(model.credential);
      if (value) out.push(value);
    }
  }
  return out;
}

async function startServer(model) {
  if (await listening()) throw new Error(`port ${PORT} is busy`);

  console.log(`  loading ${model.label}`);
  const child = spawn(
    LLAMA,
    [
      "serve", "-m", model.path, "--port", String(PORT),
      "-c", String(model.contextSize), "-ngl", String(model.gpuLayers),
      ...(model.extraArgs ?? []), "--no-warmup",
    ],
    { stdio: ["ignore", "pipe", "pipe"] },
  );

  let log = "";
  child.stdout.on("data", (d) => (log += d));
  child.stderr.on("data", (d) => (log += d));
  const failed = new Promise((_, reject) =>
    child.on("exit", (code) => reject(new Error(`llama exited ${code}:\n${log.slice(-1500)}`))),
  );

  const stop = async () => {
    spawn("taskkill", ["/pid", String(child.pid), "/t", "/f"], { stdio: "ignore" });
    for (let i = 0; i < 120 && (await listening()); i++) await sleep(500);
    await sleep(2000);
  };

  try {
    await Promise.race([waitReady(), failed]);
  } catch (err) {
    await stop().catch(() => {});
    throw err;
  }
  console.log("  ready");
  return { stop };
}

async function waitReady() {
  const deadline = Date.now() + 900_000;
  for (;;) {
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/v1/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ messages: [{ role: "user", content: "ready?" }], max_tokens: 1 }),
      });
      if (res.ok) return;
      if (res.status !== 503) throw new Error(`server answered ${res.status}`);
    } catch (err) {
      if (String(err.message).startsWith("server answered")) throw err;
    }
    if (Date.now() > deadline) throw new Error("server never became ready");
    await sleep(2000);
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
