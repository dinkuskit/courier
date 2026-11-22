import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// EmDash's runtime imports modules that Astro generates for a real site. These
// tests build the runtime themselves, so each one is an empty stand-in.
const stub = fileURLToPath(new URL("./tests/stubs/virtual.js", import.meta.url));

export default defineConfig({
  resolve: {
    alias: [{ find: /^virtual:emdash\/.*$/, replacement: stub }],
  },
  test: {
    include: ["tests/**/*.test.js"],
    environment: "node",
    server: { deps: { inline: [/emdash/] } },
    testTimeout: 30_000,
  },
});
