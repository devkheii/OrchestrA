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

  // EXCLUDED after run 3 (see README.md). Kept so that runs 1 and 3 stay
  // reproducible, and because what it established is worth keeping.
  //
  // Not slow -- unmeasurable. Run 1 gave it 3,072 tokens at 3.8 tok/s and 29
  // of 60 truncated; run 3 gave it 8,192 at roughly 13 tok/s and 33 truncated.
  // Four times the budget and four times the speed moved nothing, because the
  // constraint is tokens per answer against a context that fits in 8GB, and
  // neither of those changed.
  //
  // A statement about the deployment, not the model: of the 27 answers it did
  // finish in run 3, it passed 27.
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
    // QuantFactory's 2024 repack, not TheBloke's 2023 one. The older file
    // carries no chat template and no pre-tokenizer type, so llama.cpp fell
    // back to ChatML: the model was prompted in a format it was not trained on
    // and its stop token was never recognised, so it answered correctly and
    // then hallucinated a conversation with itself until the budget ran out --
    // 58 of 60 tasks. The server's own log said GENERATION QUALITY WILL BE
    // DEGRADED. That is a defective fixture, not a model result.
    path: "E:/models/deepseek-coder-6.7b-instruct-QF-Q6_K.gguf",
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
  // A control, not a council member. Identical weights and settings to `qwen`,
  // differing only in KV cache quantization, so that re-scoring it answers one
  // question: does q4_0 KV move verdicts on this benchmark?
  //
  // It matters because q4 KV is what makes a reasoning model fast enough to
  // measure here (8.6 -> 15.1 tok/s), and buying speed by degrading the model
  // would mean measuring a different model. Received wisdom says q4 KV is a
  // real trade and q8_0 is near-lossless; this turns that into a number on the
  // set actually in use.
  // The same control at q8_0. q4_0 did not degrade this model, it destroyed
  // it: 0/60, answering with a bare "from" inside a code fence in 7 tokens.
  // Received wisdom is that the K cache is far more sensitive than the V cache
  // and that q8_0 is near-lossless; this measures whether that holds here.
  qwen_kv8: {
    key: "qwen_kv8",
    label: "Qwen2.5-Coder-7B-Instruct (q8_0 KV)",
    quant: "Q6_K",
    family: "Qwen",
    path: "E:/models/Qwen2.5-Coder-7B-Instruct-Q6_K.gguf",
    contextSize: 4096,
    maxTokens: 1024,
    gpuLayers: 999,
    extraArgs: ["-fa", "on", "-ctk", "q8_0", "-ctv", "q8_0"],
  },

  qwen_kv4: {
    key: "qwen_kv4",
    label: "Qwen2.5-Coder-7B-Instruct (q4_0 KV)",
    quant: "Q6_K",
    family: "Qwen",
    path: "E:/models/Qwen2.5-Coder-7B-Instruct-Q6_K.gguf",
    contextSize: 4096,
    maxTokens: 1024,
    gpuLayers: 999,
    extraArgs: ["-fa", "on", "-ctk", "q4_0", "-ctv", "q4_0"],
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

/**
 * Run 3's server configuration, measured rather than assumed.
 *
 * A q8_0 KV cache with flash attention scored 46/60 against fp16's 46/60 on
 * the same model, with zero verdict flips and 52 of 60 answers byte-identical
 * -- and eleven times faster, because the layers that were spilling to the CPU
 * no longer have to. q4_0 is not the cheaper version of this: it scored 0/60.
 */
const KV8 = ["-fa", "on", "-ctk", "q8_0", "-ctv", "q8_0"];

const withKv8 = (model, overrides = {}) => ({ ...model, extraArgs: KV8, ...overrides });

/**
 * Run 3: all four models under one server configuration.
 *
 * Nothing is reused from run 2. The settings changed, and comparing answers
 * produced under different settings invites exactly the objection this run
 * exists to close -- that a difference between models was really a difference
 * between configurations.
 *
 * Gemma gets 8x the budget because it is the only reasoning model here and run
 * 1 established that 3,072 tokens truncates it on half the set. The comparison
 * is between answers, not between token counts; what the extra budget costs in
 * latency is reported separately.
 */
export const RUN3 = [
  withKv8(ALL.qwen),
  withKv8(ALL.deepseek),
  withKv8(ALL.llama),
  // -ngl -1, not 999. At 8192 context with every layer forced onto the card,
  // the server loads, answers a short probe, and then dies once a real
  // generation fills the KV cache -- it managed one task before taking the
  // rest of the run down with it. Auto-fit is 10.8 tok/s against 13.9 and
  // survives, which is the better trade for a measurement.
  withKv8(ALL.gemma, { contextSize: 8192, maxTokens: 8192, gpuLayers: -1 }),
];

/** Named sets, so a run selects one without editing this file. */
export const SETS = { run1: MODELS, run2: RUN2, run3: RUN3 };
