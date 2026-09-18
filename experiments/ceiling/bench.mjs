import { spawn } from "node:child_process";
import { LLAMA, PORT } from "./models.mjs";

/**
 * Which server configuration actually runs Gemma fastest on this card.
 *
 * Measured rather than guessed, because the run costs hours and the first
 * guess was wrong by more than 2x. Only settings that do not change what the
 * model computes are candidates — a faster number bought by degrading the
 * model would be measuring a different model.
 */

const MODEL = "E:/models/gemma-4-12b-it-Q4_K_M.gguf";
const CONFIGS = [
  { name: "ngl -1 (what the run used)", args: ["-c", "4096", "-ngl", "-1"] },
  { name: "ngl 999 + flash-attn", args: ["-c", "4096", "-ngl", "999", "-fa", "on"] },
  { name: "ngl 999 + fa + ctx 2048", args: ["-c", "2048", "-ngl", "999", "-fa", "on"] },
];

const PROMPT = "Write a Python function that returns the n-th Fibonacci number. Think it through first.";

for (const config of CONFIGS) {
  const child = spawn(LLAMA, ["serve", "-m", MODEL, "--port", String(PORT), ...config.args, "--no-warmup"],
    { stdio: ["ignore", "pipe", "pipe"] });
  let log = "";
  child.stdout.on("data", (d) => (log += d));
  child.stderr.on("data", (d) => (log += d));

  try {
    await ready();
    const at = Date.now();
    const res = await fetch(`http://127.0.0.1:${PORT}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        messages: [{ role: "user", content: PROMPT }],
        max_tokens: 400, temperature: 0, seed: 1,
      }),
    });
    const body = await res.json();
    const secs = (Date.now() - at) / 1000;
    const tokens = body.usage?.completion_tokens ?? 0;
    const offload = (log.match(/offloaded (\d+\/\d+) layers/) ?? [])[1] ?? "?";
    console.log(`${config.name.padEnd(30)} ${(tokens / secs).toFixed(1)} tok/s  (${tokens} in ${secs.toFixed(0)}s, layers ${offload})`);
  } catch (err) {
    console.log(`${config.name.padEnd(30)} FAILED: ${String(err.message).slice(0, 120)}`);
  } finally {
    spawn("taskkill", ["/pid", String(child.pid), "/t", "/f"], { stdio: "ignore" });
    await new Promise((r) => setTimeout(r, 12000));
  }
}

async function ready() {
  const deadline = Date.now() + 300_000;
  for (;;) {
    try { if ((await fetch(`http://127.0.0.1:${PORT}/v1/models`)).ok) return; } catch {}
    if (Date.now() > deadline) throw new Error("never became ready");
    await new Promise((r) => setTimeout(r, 1000));
  }
}
