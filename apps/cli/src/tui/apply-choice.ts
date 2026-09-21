import type { StartChoice } from "./start.js";

/**
 * Writing down what the start menu chose (SPEC §33.2).
 *
 * Every choice becomes a **named provider**. A discovered endpoint used to be
 * written as the flat configuration, which selection does not look at when
 * named providers exist — so choosing a model from the menu produced "several
 * providers are configured and none is chosen". The menu had made a choice
 * that selection could not see.
 *
 * Separate from the CLI so it can be tested without a terminal: it is the part
 * that decides what the file says.
 */
export function applyStartChoice(
  config: Record<string, unknown>,
  choice: StartChoice,
): void {
  if (choice.provider) {
    // An existing entry is selected, never rewritten. It is the user's.
    config["provider"] = choice.provider;
    return;
  }

  if (!choice.newEndpoint) return;

  const providers = (config["providers"] ?? {}) as Record<string, Record<string, unknown>>;
  const name = uniqueName(nameFor(choice.newEndpoint), providers, choice.newEndpoint.baseUrl);

  const entry: Record<string, unknown> = { baseUrl: choice.newEndpoint.baseUrl };
  if (choice.newEndpoint.model) entry["model"] = choice.newEndpoint.model;
  // Weights belong to the endpoint that serves them, not to the file
  // (SPEC §33.2). At the top level this applied to whichever provider happened
  // to be selected next.
  if (choice.newEndpoint.modelPath) entry["modelPath"] = choice.newEndpoint.modelPath;

  providers[name] = entry;
  config["providers"] = providers;
  config["provider"] = name;

  // The flat form is what this replaces; leaving it would be a second place a
  // model name could come from.
  delete config["baseUrl"];
  delete config["model"];
  delete config["modelPath"];
}

/** A short name a person would recognise in a list. */
function nameFor(endpoint: { baseUrl: string; model?: string | undefined }): string {
  const base = endpoint.model ?? new URL(endpoint.baseUrl).host;
  return (
    base
      .toLowerCase()
      .replace(/\.gguf$/i, "")
      .replace(/[^a-z0-9.-]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 32) || "provider"
  );
}

/**
 * The same name for the same endpoint, a new one otherwise.
 *
 * Re-choosing something already configured should select it rather than
 * accumulate `qwen`, `qwen-2`, `qwen-3` down the file.
 */
function uniqueName(
  base: string,
  providers: Record<string, Record<string, unknown>>,
  baseUrl: string,
): string {
  if (providers[base]?.["baseUrl"] === baseUrl) return base;
  if (!providers[base]) return base;

  for (let n = 2; ; n++) {
    const candidate = `${base}-${n}`;
    if (providers[candidate]?.["baseUrl"] === baseUrl) return candidate;
    if (!providers[candidate]) return candidate;
  }
}
