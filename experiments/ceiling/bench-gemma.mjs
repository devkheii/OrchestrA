import { spawn } from "node:child_process";
import { LLAMA, PORT } from "./models.mjs";

/**
 * Can Gemma be made fast enough to measure?
 *
 * Run 1 was invalid because Gemma truncated 29 of 60 tasks at 4.7 tok/s. If a
 * configuration puts every layer on the card, the same model becomes a valid
 * arm - and it is the most plausible candidate for decorrelated failures among
 * what runs locally, which is the open question run 2 left.
 *
 * Flash attention is mathematically the same computation with a smaller
 * workspace, so it is free. KV cache quantization is not free: q8_0 is close
 * to lossless in practice, q4_0 is a real trade. Both are measured, and which
 * one is acceptable is a separate decision from which one is fast.
 */

const MODEL = "E:/models/gemma-4-12b-it-Q4_K_M.gguf";
const CONFIGS = [
  { name: "ngl -1 (run 1 baseline)", args: ["-c", "4096", "-ngl", "-1"] },
  { name: "ngl -1, fa on", args: ["-c", "4096", "-ngl", "-1", "-fa", "on"] },
  { name: "ngl 999, fa on, kv q8_0", args: ["-c", "4096", "-ngl", "999", "-fa", "on", "-ctk", "q8_0", "-ctv", "q8_0"] },
  { name: "ngl 999, fa on, kv q4_0", args: ["-c", "4096", "-ngl", "999", "-fa", "on", "-ctk", "q4_0", "-ctv", "q4_0"] },
  { name: "ngl -1, fa on, kv q4_0", args: ["-c", "4096", "-ngl", "-1", "-fa", "on", "-ctk", "q4_0", "-ctv", "q4_0"] },
];

// Long enough to spend real time in decode rather than in prompt processing.
const PROMPT = "Write a Python function that returns the n-th Fibonacci number, then explain the time complexity of your approach in two sentences.";

for (const config of CONFIGS) {
  const child = spawn(LLAMA, ["serve", "-m", MODEL, "--port", String(PORT), ...config.args, "--no-warmup"],
    { stdio: ["ignore", "pipe", "pipe"] });
  let log = "";
  child.stdout.on("data", (d) => (log += d));
  child.stderr.on("data", (d) => (log += d));

  let line = `${config.name.padEnd(28)} `;
  try {
    await ready();
    const at = Date.now();
    const res = await fetch(`http://127.0.0.1:${PORT}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        messages: [{ role: "user", content: PROMPT }],
        max_tokens: 600, temperature: 0, seed: 20260918,
      }),
    });
    const body = await res.json();
    const secs = (Date.now() - at) / 1000;
    const tokens = body.usage?.completion_tokens ?? 0;
    const layers = (log.match(/offloading (\d+) repeating layers to GPU/) ?? [])[1]
      ?? (log.match(/offloaded (\d+\/\d+) layers/) ?? [])[1] ?? "?";
    const gpu = (log.match(/CUDA0 model buffer size\s*=\s*([\d.]+)/) ?? [])[1] ?? "?";
    const cpu = (log.match(/CPU model buffer size\s*=\s*([\d.]+)/) ?? [])[1]
      ?? (log.match(/CPU_Mapped model buffer size\s*=\s*([\d.]+)/) ?? [])[1] ?? "?";
    line += `${(tokens / secs).toFixed(1)} tok/s  (${tokens} tok, ${secs.toFixed(0)}s)  layers=${layers}  gpuMiB=${gpu} cpuMiB=${cpu}`;
  } catch (err) {
    line += `FAILED: ${String(err.message).slice(0, 100)}`;
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
