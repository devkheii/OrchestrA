import { readCredential } from "./credentials.mjs";

/**
 * Can thinking be turned off?
 *
 * If it can, the two endpoints become a clean test: same weights or same
 * family, one reasoning and one not, so answer *style* is isolated from
 * lineage. If it cannot, the pair is two same-family reasoning models, which
 * is the most correlated configuration available and tests nothing.
 */

const ENDPOINTS = [
  { name: "qwen-27b", url: "http://10.50.140.134:8002/v1", credential: "qwen-27b", model: "qwen3.8-27b" },
  { name: "qwen-flash", url: "http://10.50.140.168:8000/v1", credential: "qwen-flash", model: "qwen3.8-flash-next" },
];

// The shapes different servers accept for the same request.
const VARIANTS = [
  { label: "chat_template_kwargs.enable_thinking=false", extra: { chat_template_kwargs: { enable_thinking: false } } },
  { label: "enable_thinking=false (top level)", extra: { enable_thinking: false } },
  { label: "reasoning_effort=none", extra: { reasoning_effort: "none" } },
  { label: "thinking={type:disabled}", extra: { thinking: { type: "disabled" } } },
  { label: "/no_think in the prompt", suffix: " /no_think" },
];

const PROMPT = "What is 17 + 25? Reply with only the number.";

for (const endpoint of ENDPOINTS) {
  const key = await readCredential(endpoint.credential);
  const headers = { "content-type": "application/json", authorization: `Bearer ${key}` };
  console.log(`\n=== ${endpoint.name}`);

  for (const variant of VARIANTS) {
    try {
      const res = await fetch(`${endpoint.url}/chat/completions`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          model: endpoint.model,
          messages: [{ role: "user", content: PROMPT + (variant.suffix ?? "") }],
          max_tokens: 1024,
          temperature: 0,
          ...(variant.extra ?? {}),
        }),
      });
      const body = await res.json();
      const choice = body.choices?.[0];
      if (!choice) {
        console.log(`  ${variant.label.padEnd(44)} rejected: ${JSON.stringify(body).slice(0, 110)}`);
        continue;
      }
      const reasoning = choice.message?.reasoning_content ?? choice.message?.reasoning ?? "";
      const rtok = body.usage?.completion_tokens_details?.reasoning_tokens ?? "-";
      const answer = (choice.message?.content ?? "").trim();
      console.log(
        `  ${variant.label.padEnd(44)} reasoning ${String(reasoning.length).padStart(5)} chars, ` +
        `${String(rtok).padStart(4)} tok | answer ${JSON.stringify(answer.slice(0, 30))}`,
      );
    } catch (err) {
      console.log(`  ${variant.label.padEnd(44)} failed: ${String(err.message).slice(0, 80)}`);
    }
  }
}
