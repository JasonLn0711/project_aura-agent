import { defineConfig } from "vitest/config";

export default defineConfig({
  root: import.meta.dirname,
  resolve: {
    alias: {
      "@": import.meta.dirname,
      "server-only": `${import.meta.dirname}/tests/server-only.ts`,
    },
  },
  test: {
    environment: "jsdom",
    exclude: [
      ".next/**",
      ".next-local/**",
      "tests/e2e/**",
      "tests/live/**",
      "node_modules/**",
    ],
    setupFiles: ["./tests/setup.ts"],
    coverage: {
      provider: "v8",
      include: [
        "components/control-room.tsx",
        "lib/security.ts",
        "lib/service-status.ts",
      ],
      reporter: ["text", "json-summary"],
      thresholds: {
        branches: 50,
        functions: 60,
        lines: 55,
        statements: 55,
      },
    },
  },
});
