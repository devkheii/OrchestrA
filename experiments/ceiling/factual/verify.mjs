import { readCredential } from "../credentials.mjs";
import { ALL, SAMPLING } from "../models.mjs";

/** PREREG-F1 condition 4: prove each configuration on a known answer first. */
const KEYS = ["q27-flat", "qf-flat", "llama"];
const Q = "What is the capital city of France?";

for (const key of KEYS) {
  const model = ALL[key];
  if (!model.remote) { console.log(`${key.padEnd(10)} local — proved when the server starts`); continue; }
  const token = await readCredential(model.credential);
  const res = await fetch(`${model.baseUrl}/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify({
      model: model.remoteModel,
      messages: [{ role: "user", content: `Answer with just the answer. If you do not know, reply exactly: UNKNOWN\n\n${Q}` }],
      max_tokens: 64, ...SAMPLING, ...(model.extraBody ?? {}),
    }),
  });
  const body = await res.json();
  const answer = (body.choices?.[0]?.message?.content ?? "").trim();
  const reasoning = body.choices?.[0]?.message?.reasoning_content ?? "";
  console.log(`${key.padEnd(10)} ${answer.toLowerCase().includes("paris") ? "CORRECT" : "WRONG"}  reasoning=${reasoning.length}ch  ${JSON.stringify(answer.slice(0, 40))}`);
}
