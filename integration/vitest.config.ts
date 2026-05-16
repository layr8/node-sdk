import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globalSetup: "./global-setup.ts",
    include: [
      "both/**/*.test.ts",
      "sender-node/**/*.test.ts",
      "receiver-node/**/*.test.ts",
    ],
    testTimeout: 30_000,
  },
});
