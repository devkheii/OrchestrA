import { readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Finding what is already on this machine (SPEC §33.3).
 *
 * A first run used to require the user to know that they wanted an
 * OpenAI-compatible endpoint, which port theirs was on, what their model was
 * called, and where `.dem/config.json` goes. Everyone who already knows all of
 * that has a harness. The gap was not a missing feature; there was no first
 * minute.
 *
 * Nothing here guesses or configures. It reports what answered and what is on
 * disk, and the user chooses.
 */

export interface DiscoveredServer {
  baseUrl: string;
  /** What is probably running, named from the port it answered on. */
  kind: string;
  models: string[];
}

export interface DiscoveredWeights {
  path: string;
  sizeBytes: number;
}

/**
 * Ports worth trying, and what usually holds them.
 *
 * A guess about the name only. Whatever answers is described by what it
 * serves, not by what this table expects it to be.
 */
const KNOWN_PORTS: ReadonlyArray<readonly [number, string]> = [
  [11434, "Ollama"],
  [1234, "LM Studio"],
  [8080, "llama.cpp"],
  [8099, "llama.cpp"],
  [8000, "vLLM or llama.cpp"],
  [5000, "text-generation-webui"],
  [1337, "Jan"],
  [4000, "LiteLLM"],
  [11435, "Ollama"],
];

export interface DiscoverServerOptions {
  ports?: readonly number[];
  host?: string;
  timeoutMs?: number;
}

export async function discoverServers(
  options: DiscoverServerOptions = {},
): Promise<DiscoveredServer[]> {
  const host = options.host ?? "127.0.0.1";
  const ports = options.ports ?? KNOWN_PORTS.map(([port]) => port);
  const timeoutMs = options.timeoutMs ?? 1200;

  // All at once. Probing nine ports in turn, each waiting out its own timeout,
  // would make a first run feel broken on a machine with nothing running —
  // which is exactly the machine that most needs the first run to be quick.
  const results = await Promise.all(ports.map((port) => probe(host, port, timeoutMs)));
  return results.filter((r): r is DiscoveredServer => r !== undefined);
}

async function probe(
  host: string,
  port: number,
  timeoutMs: number,
): Promise<DiscoveredServer | undefined> {
  const baseUrl = `http://${host}:${port}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(`${baseUrl}/v1/models`, { signal: controller.signal });
    if (!res.ok) return undefined;

    const body = (await res.json()) as { data?: Array<{ id?: string }> };
    const models = (body.data ?? []).map((m) => m.id).filter((id): id is string => Boolean(id));
    const known = KNOWN_PORTS.find(([p]) => p === port);

    return { baseUrl, kind: known?.[1] ?? "OpenAI-compatible", models };
  } catch {
    // Refused, timed out, not an API, or answering something that is not JSON.
    // All of them mean the same thing here: nothing usable on this port.
    return undefined;
  } finally {
    clearTimeout(timer);
  }
}

/** Places people keep weights. Absent directories are simply not there. */
function defaultWeightDirs(home: string): string[] {
  return [
    join(home, "models"),
    join(home, ".cache", "llama.cpp"),
    join(home, ".cache", "lm-studio", "models"),
    join(home, ".lmstudio", "models"),
    join(home, ".ollama", "models"),
    join(process.cwd(), "models"),
    "E:/models",
    "D:/models",
    "C:/models",
    "/opt/models",
  ];
}

export interface DiscoverWeightsOptions {
  dirs?: readonly string[];
  home?: string;
  /** Cap, so a directory of hundreds does not become a menu of hundreds. */
  limit?: number;
}

export async function discoverWeights(
  options: DiscoverWeightsOptions = {},
): Promise<DiscoveredWeights[]> {
  const dirs = options.dirs ?? defaultWeightDirs(options.home ?? homedir());
  const found: DiscoveredWeights[] = [];

  for (const dir of dirs) {
    // One level down as well: weights are usually in a directory named after
    // the model rather than loose.
    await collect(dir, found, 1);
  }

  // Largest first. Within one collection that usually tracks capability, and
  // it is the only ordering available without loading anything.
  found.sort((a, b) => b.sizeBytes - a.sizeBytes);
  return found.slice(0, options.limit ?? 20);
}

async function collect(dir: string, into: DiscoveredWeights[], depth: number): Promise<void> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return; // Not there, or not readable. Neither is an error to report here.
  }

  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (depth > 0) await collect(path, into, depth - 1);
      continue;
    }
    if (!entry.name.toLowerCase().endsWith(".gguf")) continue;
    try {
      into.push({ path, sizeBytes: (await stat(path)).size });
    } catch {
      // Vanished between listing and stat. Not worth reporting.
    }
  }
}

/** A model list a person can read, however many the server reports. */
export function labelForModels(models: readonly string[]): string {
  if (models.length === 0) return "no models reported";
  if (models.length <= 3) return models.join(", ");
  return `${models.slice(0, 2).join(", ")} and ${models.length - 2} more (${models.length} total)`;
}

/** Bytes as something readable in a menu. */
export function humanSize(bytes: number): string {
  const gb = bytes / 1024 ** 3;
  if (gb >= 1) return `${gb.toFixed(1)}GB`;
  return `${Math.max(1, Math.round(bytes / 1024 ** 2))}MB`;
}
