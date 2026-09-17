/**
 * The two models, and the fact that decides the whole execution plan:
 * each is about 7.5GB and the card has 8192 MiB, so they are never resident
 * together. The run is therefore batched by model — load once, answer every
 * task, unload — rather than by task. Swapping per task would spend more time
 * moving weights than deciding anything.
 */
export const MODELS = [
  {
    key: "qwen",
    label: "Qwen2.5-Coder-7B-Instruct",
    quant: "Q6_K",
    path: "E:/models/Qwen2.5-Coder-7B-Instruct-Q6_K.gguf",
    contextSize: 4096,
    maxTokens: 1024,
    // Fits entirely in VRAM; measured at 57 tok/s.
    gpuLayers: 999,
  },
  {
    key: "gemma",
    label: "Gemma-4-12B-it",
    quant: "Q4_K_M",
    path: "E:/models/gemma-4-12b-it-Q4_K_M.gguf",
    contextSize: 4096,
    // A reasoning model: a representative answer spent 583 of 726 tokens
    // before the code. A budget sized for Qwen would truncate it mid-thought
    // and score it as a failure it did not commit.
    maxTokens: 3072,
    // Partially offloaded; measured at 8.8 tok/s. -1 lets llama.cpp fit it.
    gpuLayers: -1,
  },
];

export const LLAMA = "C:/Users/Kheii/AppData/Local/llama-app/llama.exe";
export const PORT = 8099;

/** Fixed so a re-run reproduces the same answers, and recorded in the results. */
export const SAMPLING = { temperature: 0, top_p: 1, seed: 20260918 };
