import { readCredential } from "./credentials.mjs";
import { RUN4, SAMPLING } from "./models.mjs";

/**
 * PREREG-4 validity condition 4: prove each configuration before using it.
 *
 * For the two flat configurations this also confirms thinking is actually off.
 * A flag the server silently ignores would turn this experiment into four
 * copies of the same thing, and the cells would look like a result.
 */

const PROMPT = "What is 17 + 25? Reply with only the number.";
let ok = true;

for (const model of RUN4) {
  const key = await readCredential(model.credential);
  const res = await fetch(`${model.baseUrl}/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
    body: JSON.stringify({
      model: model.remoteModel,
      messages: [{ role: "user", content: PROMPT }],
      max_tokens: 2048,
      ...SAMPLING,
      ...model.extraBody,
    }),
  });
  const body = await res.json();
  const choice = body.choices?.[0];
  const reasoning = choice?.message?.reasoning_content ?? choice?.message?.reasoning ?? "";
  const answer = (choice?.message?.content ?? "").trim();

  const wantsThinking = model.extraBody.chat_template_kwargs.enable_thinking;
  const correct = answer.includes("42");
  const thinkingMatches = wantsThinking ? reasoning.length > 0 : reasoning.length === 0;

  if (!correct || !thinkingMatches) ok = false;
  console.log(
    `${model.key.padEnd(11)} thinking=${String(wantsThinking).padEnd(5)} ` +
      `reasoning=${String(reasoning.length).padStart(5)}ch  answer=${JSON.stringify(answer.slice(0, 20)).padEnd(8)} ` +
      `${correct ? "CORRECT" : "WRONG"}  ${thinkingMatches ? "mode as requested" : "MODE IGNORED"}`,
  );
}

console.log(ok ? "\nall four configurations proved" : "\nNOT PROVED - do not run");
process.exit(ok ? 0 : 1);
