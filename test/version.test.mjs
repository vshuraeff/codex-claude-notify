import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";

const packagePath = fileURLToPath(new URL("../package.json", import.meta.url));
const pluginPath = fileURLToPath(
  new URL("../plugins/codex-claude-notify/.codex-plugin/plugin.json", import.meta.url),
);

test("package and plugin versions match", async () => {
  const [packageContents, pluginContents] = await Promise.all([
    readFile(packagePath, "utf8"),
    readFile(pluginPath, "utf8"),
  ]);
  const packageJson = JSON.parse(packageContents);
  const pluginJson = JSON.parse(pluginContents);

  assert.strictEqual(packageJson.version, pluginJson.version);
  // prerelease/build metadata (e.g. -beta, +build) is intentionally not supported by this check.
  assert.match(packageJson.version, /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/);
});
