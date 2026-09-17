#!/usr/bin/env node
/**
 * A stand-in for `llama serve`: takes the same shape of arguments and opens a
 * port, so the launcher can be tested without a model or a GPU.
 *
 * `SCENARIO_EXIT` as the model path makes it fail during startup instead, the
 * way a real server does when it cannot load what it was given.
 */

import { createServer } from "node:http";

const argv = process.argv.slice(2);
const portIndex = argv.indexOf("--port");
const modelIndex = argv.indexOf("-m");
const port = portIndex === -1 ? 0 : Number(argv[portIndex + 1]);
const model = modelIndex === -1 ? "" : argv[modelIndex + 1];

if (String(model).includes("SCENARIO_EXIT")) {
  process.stderr.write("error: failed to load model: unsupported file type\n");
  process.exit(1);
}

const server = createServer((_, res) => {
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify({ object: "list", data: [] }));
});

server.listen(port, "127.0.0.1", () => {
  process.stdout.write(`listening on http://127.0.0.1:${port}\n`);
});
