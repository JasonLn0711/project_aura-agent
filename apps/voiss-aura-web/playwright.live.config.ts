import { defineConfig, devices } from "@playwright/test";

if (process.env.VOISS_LIVE_E2E === "1") {
  const required = [
    "AURA_BRIDGE_URL",
    "AURA_BRIDGE_TOKEN",
    "CODEX_BRIDGE_URL",
    "CODEX_BRIDGE_TOKEN",
    "VOISS_DB_PATH",
    "VOISS_AGENT_DB_PATH",
    "VOISS_LIVE_REPO_ROOT",
  ];
  const missing = required.filter((name) => !process.env[name]);
  if (missing.length > 0) {
    throw new Error(`Live E2E requires: ${missing.join(", ")}`);
  }
}

export default defineConfig({
  testDir: "./tests/live",
  reporter: "list",
  timeout: 600_000,
  use: {
    baseURL: "http://127.0.0.1:3002",
    trace: "retain-on-failure",
  },
  webServer: {
    command:
      "COPILOTKIT_TELEMETRY_DISABLED=true VOISS_MODE=local VOISS_WEB_ORIGINS=http://127.0.0.1:3002 pnpm exec next dev --hostname 127.0.0.1 --port 3002",
    url: "http://127.0.0.1:3002",
    reuseExistingServer: false,
    timeout: 120_000,
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
});
