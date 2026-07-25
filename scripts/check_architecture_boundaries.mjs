import { readFileSync, readdirSync } from "node:fs";
import { extname, join } from "node:path";
import { strict as assert } from "node:assert";

const root = new URL("..", import.meta.url).pathname.replace(/\/$/, "");
const skippedDirectories = new Set([
  ".next",
  ".next-local",
  ".voiss",
  "node_modules",
  "playwright-report",
  "test-results",
]);

function filesUnder(relative) {
  const files = [];
  const walk = (path) => {
    for (const entry of readdirSync(path, { withFileTypes: true })) {
      if (entry.isDirectory() && skippedDirectories.has(entry.name)) continue;
      const child = join(path, entry.name);
      if (entry.isDirectory()) walk(child);
      else if ([".ts", ".tsx", ".py"].includes(extname(child)))
        files.push(child);
    }
  };
  walk(join(root, relative));
  return files;
}

function combined(relative) {
  return filesUnder(relative)
    .map((path) => readFileSync(path, "utf8"))
    .join("\n");
}

const web = combined("apps/voiss-aura-web");
const auraBridge = combined("services/aura-bridge/src");
const trust = combined("packages/trust-engine/src");
const domain = combined("packages/domain/src");
const client = filesUnder("apps/voiss-aura-web/components")
  .map((path) => readFileSync(path, "utf8"))
  .join("\n");
const audioRoute = readFileSync(
  join(root, "apps/voiss-aura-web/app/api/aura-audio/route.ts"),
  "utf8",
);

assert.doesNotMatch(web, /aura\.ui\.transcription_tab|PyQt/);
assert.doesNotMatch(auraBridge, /aura\.ui\.transcription_tab|PyQt/);
assert.doesNotMatch(trust, /from ["']react|@copilotkit\/react/);
assert.doesNotMatch(domain, /node:(?:fs|sqlite)|from ["']react/);
assert.doesNotMatch(
  client,
  /process\.env\.(?:AURA_BRIDGE_TOKEN|CODEX_BRIDGE_TOKEN|OPENAI_API_KEY)/,
);
assert.match(audioRoute, /meeting_id/);
assert.doesNotMatch(audioRoute, /\b(?:file_?path|absolute_?path)\b/i);

console.log("Architecture boundaries: PASS");
