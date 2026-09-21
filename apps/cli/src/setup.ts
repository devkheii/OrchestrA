import { createInterface } from "node:readline/promises";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  discoverServers,
  discoverWeights,
  humanSize,
  labelForModels,
  writeCredential,
  type DiscoveredServer,
  type DiscoveredWeights,
} from "@dem/engine";
import type { Io } from "./session-ui.js";

/**
 * `dem setup` — the first minute.
 *
 * Before this, a new user got an interactive prompt backed by a fake provider
 * that echoed their question back. Nothing said it was fake unless they ran
 * `dem models` and read the header. Silently appearing to work is worse than
 * refusing to start, because it spends the user's trust before the tool has
 * done anything.
 *
 * What was actually missing was not a feature. It was the assumption that a
 * new user already knows they want an OpenAI-compatible endpoint, which port
 * theirs is on, what their model is called, and where the config file goes.
 * Everyone who knows all that already has a harness.
 */

/**
 * Setup succeeded and the caller should carry on into a session.
 *
 * A distinct value rather than 0, because `dem setup` run on its own should
 * exit and bare `dem` should continue; the difference belongs to the caller.
 */
export const SETUP_DONE = -1;

interface Choice {
  label: string;
  detail: string;
  apply: (config: Record<string, unknown>) => Promise<void>;
}

export async function runSetup(io: Io, workspace: string = process.cwd()): Promise<number> {
  const home = homedir();

  if (!process.stdin.isTTY) {
    io.err(
      "dem setup needs a terminal it can ask questions in.\n" +
        "Write .dem/config.json by hand instead — see: dem help\n",
    );
    return 2;
  }

  io.err("\n[1mdem setup[0m\n");
  io.err("[2mlooking for models on this machine…[0m\n");

  const [servers, weights] = await Promise.all([discoverServers(), discoverWeights({ home })]);
  const choices = buildChoices(servers, weights, io);

  if (choices.length === 0) {
    io.err("\nNothing found. dem needs a model to talk to; there are three ways:\n\n");
    io.err("  [1mA local server[0m — Ollama, LM Studio or llama.cpp. Start one, then run dem setup again.\n");
    io.err("  [1mLocal weights[0m — a .gguf file. dem can serve it itself if you give it the path.\n");
    io.err("  [1mA remote API[0m — anything OpenAI-compatible, or the Anthropic API.\n\n");
    io.err("Run [1mdem setup --manual[0m to type an endpoint in directly.\n");
    return 1;
  }

  io.err(`\nFound ${choices.length}:\n\n`);
  choices.forEach((choice, i) => {
    io.err(`  [1m${i + 1}[0m  ${choice.label}\n      [2m${choice.detail}[0m\n`);
  });
  io.err(`  [1m${choices.length + 1}[0m  something else — type an endpoint myself\n\n`);

  const rl = createInterface({ input: process.stdin, output: process.stderr });
  try {
    const answer = (await rl.question(`which? [1-${choices.length + 1}] `)).trim();
    const index = Number.parseInt(answer, 10) - 1;

    const config: Record<string, unknown> = await readExisting(workspace);

    if (index === choices.length) {
      await manual(rl, io, config, home);
    } else if (index >= 0 && index < choices.length) {
      await choices[index]!.apply(config);
    } else {
      io.err("nothing chosen; nothing written\n");
      return 1;
    }

    await write(workspace, config);

    io.err(`\n[1mwrote ${join(workspace, ".dem", "config.json")}[0m\n`);
    io.err("[2mit is a plain file; edit it or re-run dem setup any time[0m\n\n");
    // Setup ends where the user wanted to be, not with a list of commands to
    // type next. Configuring a model and then being handed homework is the
    // same dead end as not configuring one.
    return SETUP_DONE;
  } finally {
    rl.close();
  }
}

function buildChoices(
  servers: readonly DiscoveredServer[],
  weights: readonly DiscoveredWeights[],
  io: Io,
): Choice[] {
  const choices: Choice[] = [];

  for (const server of servers) {
    // One entry per model, not per server: picking a server still leaves the
    // question of which model, and asking it twice is a worse first minute
    // than a slightly longer list.
    const models = server.models.length ? server.models.slice(0, 6) : [undefined];
    for (const model of models) {
      choices.push({
        label: `${server.kind}${model ? ` — ${model}` : ""}`,
        detail: `${server.baseUrl}  ·  already running  ·  ${labelForModels(server.models)}`,
        apply: async (config) => {
          config["baseUrl"] = `${server.baseUrl}/v1`;
          if (model) config["model"] = model;
          // Weights belong to the endpoint they are served at (SPEC 33.2), and
          // this endpoint is someone else's server.
          delete config["modelPath"];
        },
      });
    }
  }

  for (const found of weights.slice(0, 6)) {
    const name = found.path.split(/[\\/]/).pop() ?? found.path;
    choices.push({
      label: `${name}`,
      detail: `${humanSize(found.sizeBytes)}  ·  ${found.path}  ·  dem will serve it with llama.cpp`,
      apply: async (config) => {
        config["modelPath"] = found.path;
        config["baseUrl"] = "http://127.0.0.1:8099";
        config["model"] = name.replace(/\.gguf$/i, "");
      },
    });
  }

  void io;
  return choices;
}

async function manual(
  rl: ReturnType<typeof createInterface>,
  io: Io,
  config: Record<string, unknown>,
  home: string,
): Promise<void> {
  const baseUrl = (await rl.question("endpoint URL (e.g. https://api.example.com/v1): ")).trim();
  if (!baseUrl) throw new Error("an endpoint is required");
  config["baseUrl"] = baseUrl;

  const model = (await rl.question("model name: ")).trim();
  if (model) config["model"] = model;

  const needsKey = (await rl.question("does it need an API key? [y/N] ")).trim().toLowerCase();
  if (needsKey === "y" || needsKey === "yes") {
    const name = (await rl.question("a name for this credential [default]: ")).trim() || "default";
    // Through the same store `dem auth` writes, so there is one place a
    // credential can be, rather than a setup-shaped exception to invariant 6.
    io.err("[2mthe key is stored in your home directory, never in this config[0m\n");
    const key = (await rl.question(`key for ${name}: `)).trim();
    if (key) {
      await writeCredential(name, key, home);
      config["apiKey"] = `secret://${name}`;
    }
  }

  // Anything not on this machine has to be said out loud (invariant 1).
  if (!/^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])/.test(baseUrl)) {
    io.err(
      "\n[1mthis endpoint is not on this machine.[0m Your prompts and the files dem reads\n" +
        "will be sent to it. Setting \"allowRemote\" so dem stops refusing.\n",
    );
    config["allowRemote"] = true;
  }
}

async function readExisting(workspace: string): Promise<Record<string, unknown>> {
  try {
    const text = await readFile(join(workspace, ".dem", "config.json"), "utf8");
    const parsed = JSON.parse(text);
    // Keeps whatever else is in there — security settings above all, which a
    // setup run has no business dropping.
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

async function write(workspace: string, config: Record<string, unknown>): Promise<void> {
  const dir = join(workspace, ".dem");
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "config.json"), JSON.stringify(config, null, 2) + "\n");
}
