import { spawn } from "node:child_process";
import { LLAMA, PORT } from "./models.mjs";

/**
 * Picking Gemma's server configuration for run 3 — and checking the output is
 * sane, not just fast.
 *
 * The previous bench reported q4_0 at 15.1 tok/s and never looked at what the
 * tokens said. They said nothing: the same setting scored 0/60. A performance
 * benchmark with no validity check measures how fast a configuration can
 * produce garbage.
 */

const MODEL = "E:/models/gemma-4-12b-it-Q4_K_M.gguf";
const KV8 = ["-fa", "on", "-ctk", "q8_0", "-ctv", "q8_0"];
const CONFIGS = [
  { name: "ngl 999, fa, kv q8_0", args: ["-c", "8192", "-ngl", "999", ...KV8] },
  { name: "ngl -1,  fa, kv q8_0", args: ["-c", "8192", "-ngl", "-1", ...KV8] },
];

// Known answer, so "fast" and "correct" are reported together.
const PROMPT = "What is 17 + 25? Reply with only the number.";

for (const config of CONFIGS) {
  const child = spawn(LLAMA, ["serve", "-m", MODEL, "--port", String(PORT), ...config.args, "--no-warmup"],
    { stdio: ["ignore", "pipe", "pipe"] });
  child.stdout.on("data", () => {});
  child.stderr.on("data", () => {});

  let line = `${config.name.padEnd(24)} `;
  try {
    await ready();
    const at = Date.now();
    const res = await fetch(`http://127.0.0.1:${PORT}/v1/chat/completions`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ messages: [{ role: "user", content: PROMPT }], max_tokens: 800, temperature: 0, seed: 20260918 }),
    });
    const body = await res.json();
    const secs = (Date.now() - at) / 1000;
    const tokens = body.usage?.completion_tokens ?? 0;
    const answer = body.choices?.[0]?.message?.content ?? "";
    const correct = answer.includes("42");
    line += `${(tokens / secs).toFixed(1)} tok/s  ${correct ? "CORRECT" : "WRONG"}  answer=${JSON.stringify(answer.slice(0, 60))}`;
  } catch (err) {
    line += `FAILED: ${String(err.message).slice(0, 90)}`;
  } finally {
    spawn("taskkill", ["/pid", String(child.pid), "/t", "/f"], { stdio: "ignore" });
    await new Promise((r) => setTimeout(r, 15000));
  }
  console.log(line);
}

async function ready() {
  const deadline = Date.now() + 420_000;
  for (;;) {
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/v1/chat/completions`, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ messages: [{ role: "user", content: "x" }], max_tokens: 1 }),
      });
      if (res.ok) return;
      if (res.status !== 503) throw new Error(`server answered ${res.status}`);
    } catch (err) {
      if (String(err.message).startsWith("server answered")) throw err;
    }
    if (Date.now() > deadline) throw new Error("never became ready");
    await new Promise((r) => setTimeout(r, 2000));
  }
}
