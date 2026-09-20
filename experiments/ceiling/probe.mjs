import { readCredential } from "./credentials.mjs";

/**
 * What are these two endpoints, actually?
 *
 * Asked before designing anything around them. The experiment's premise is
 * that one reasons and the other does not; if both answer in one shot the
 * design has no test in it, and that is worth knowing before writing a
 * pre-registration rather than after collecting 120 answers.
 */

const ENDPOINTS = [
  { name: "qwen-27b", url: "http://10.50.140.134:8002/v1", credential: "qwen-27b" },
  { name: "qwen-flash", url: "http://10.50.140.168:8000/v1", credential: "qwen-flash" },
];

const PROMPT =
  "What is 17 + 25? Reply with only the number.";

for (const endpoint of ENDPOINTS) {
  const key = await readCredential(endpoint.credential);
  const headers = { "content-type": "application/json", authorization: `Bearer ${key}` };
  console.log(`\n=== ${endpoint.name}  ${endpoint.url}`);

  try {
    const listed = await (await fetch(`${endpoint.url}/models`, { headers })).json();
    console.log("  models:", (listed.data ?? []).map((m) => m.id).join(", ") || JSON.stringify(listed).slice(0, 200));
  } catch (err) {
    console.log("  models: failed —", String(err.message).slice(0, 120));
  }

  try {
    const at = Date.now();
    const res = await fetch(`${endpoint.url}/chat/completions`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        model: process.argv[2] ?? undefined,
        messages: [{ role: "user", content: PROMPT }],
        max_tokens: 2048,
        temperature: 0,
      }),
    });
    const body = await res.json();
    const choice = body.choices?.[0];
    if (!choice) {
      console.log("  chat:", JSON.stringify(body).slice(0, 300));
      continue;
    }
    const reasoning = choice.message?.reasoning_content ?? choice.message?.reasoning ?? "";
    console.log(`  model id in reply: ${body.model}`);
    console.log(`  finish: ${choice.finish_reason}  tokens: ${JSON.stringify(body.usage)}`);
    console.log(`  seconds: ${((Date.now() - at) / 1000).toFixed(1)}`);
    console.log(`  reasoning field: ${reasoning ? reasoning.length + " chars" : "ABSENT"}`);
    console.log(`  answer: ${JSON.stringify((choice.message?.content ?? "").slice(0, 120))}`);
  } catch (err) {
    console.log("  chat: failed —", String(err.message).slice(0, 160));
  }
}
