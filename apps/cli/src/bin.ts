#!/usr/bin/env node
import { main } from "./index.js";

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (err: Error) => {
    process.stderr.write(`dem: ${err.message}\n`);
    process.exit(1);
  },
);
