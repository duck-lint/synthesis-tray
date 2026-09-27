import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    // Obsidian ships declarations only; lifecycle orchestration tests provide
    // a deterministic runtime shim for the plugin-owned boundaries.
    alias: { obsidian: new URL("./tests/obsidianShim.ts", import.meta.url).pathname },
  },
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
  },
});
