import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

const r = (p: string) => fileURLToPath(new URL(p, import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      "@dem/protocol": r("./packages/protocol/src/index.ts"),
      "@dem/engine": r("./packages/engine/src/index.ts"),
      "@dem/adapters": r("./packages/adapters/src/index.ts"),
      "@dem/daemon": r("./apps/daemon/src/index.ts"),
      "@dem/cli": r("./apps/cli/src/index.ts"),
    },
  },
  test: {
    include: ["tests/**/*.test.ts"],
    environment: "node",
    reporters: ["default"],
  },
});
