/**
 * The models, and the fact that decides the whole execution plan:
 * each is 5-7GB and the card has 8192 MiB, so no two are resident together.
 * Every run is batched by model - load once, answer every task, unload -
 * rather than by task. Swapping per task would spend more time moving weights
 * than deciding anything.
 */

export const ALL = {
  qwen: {
    key: "qwen",
    label: "Qwen2.5-Coder-7B-Instruct",
    quant: "Q6_K",
    family: "Qwen",
    path: "E:/models/Qwen2.5-Coder-7B-Instruct-Q6_K.gguf",
    contextSize: 4096,
    maxTokens: 1024,
    gpuLayers: 999,
  },

  // Run 1. Kept so that run 1's report stays reproducible, and because its
  // result is worth keeping: at 4.7 tok/s and roughly 10x the tokens per
  // answer, a reasoning model is not a viable council member on 8GB.
  gemma: {
    key: "gemma",
    label: "Gemma-4-12B-it",
    quant: "Q4_K_M",
    family: "Gemma",
    path: "E:/models/gemma-4-12b-it-Q4_K_M.gguf",
    contextSize: 4096,
    maxTokens: 3072,
    gpuLayers: -1,
  },

  // Run 2. A code specialist of comparable published strength from a different
  // lineage - the pairing most likely to have a non-zero ceiling, since the
  // ceiling is a minimum and dies if either model is simply worse.
  deepseek: {
    key: "deepseek",
    label: "DeepSeek-Coder-6.7B-Instruct",
    quant: "Q6_K",
    family: "DeepSeek",
    path: "E:/models/deepseek-coder-6.7b-instruct-Q6_K.gguf",
    contextSize: 4096,
    maxTokens: 1024,
    gpuLayers: 999,
  },

  // Run 2. A general model, weaker on code by published figures, included to
  // test the opposite hypothesis: that a *differently* wrong model contributes
  // more to a council than a similarly strong one.
  llama: {
    key: "llama",
    label: "Meta-Llama-3.1-8B-Instruct",
    quant: "Q6_K",
    family: "Llama",
    path: "E:/models/Meta-Llama-3.1-8B-Instruct-Q6_K.gguf",
    contextSize: 4096,
    maxTokens: 1024,
    gpuLayers: 999,
  },
};

/** Run 1's pair, so report.mjs keeps producing run 1's report unchanged. */
export const MODELS = [ALL.qwen, ALL.gemma];

/** Run 2. Qwen's answers are reused, not regenerated: same task set, same
 *  seed, same budget, same prompt, greedy decoding. */
export const RUN2 = [ALL.qwen, ALL.deepseek, ALL.llama];

export const LLAMA = "C:/Users/Kheii/AppData/Local/llama-app/llama.exe";
export const PORT = 8099;

/** Fixed so a re-run reproduces the same answers, and recorded in the results. */
export const SAMPLING = { temperature: 0, top_p: 1, seed: 20260918 };
