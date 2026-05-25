import { defineConfig } from "vitest/config";
import { resolve } from "node:path";

export default defineConfig({
  resolve: {
    alias: {
      "@layr8/sdk": resolve(__dirname, "../src/index.ts"),
    },
  },
  test: {
    root: resolve(__dirname),
    include: ["tests/**/*.test.ts"],
  },
});