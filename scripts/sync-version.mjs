import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDirectoryPath = path.dirname(fileURLToPath(import.meta.url));
const repositoryRootPath = path.resolve(scriptDirectoryPath, "..");
const packagePath = path.join(repositoryRootPath, "package.json");
const pluginPath = path.join(
  repositoryRootPath,
  "plugins/codex-claude-notify/.codex-plugin/plugin.json",
);
const coreSemverPattern = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

async function main() {
  const packageJson = JSON.parse(await readFile(packagePath, "utf8"));
  const pluginJson = JSON.parse(await readFile(pluginPath, "utf8"));

  if (!isPlainObject(packageJson)) {
    throw new Error("package.json must contain a JSON object");
  }
  if (!isPlainObject(pluginJson)) {
    throw new Error("plugin.json must contain a JSON object");
  }
  if (
    typeof packageJson.version !== "string" ||
    !coreSemverPattern.test(packageJson.version)
  ) {
    throw new Error("package.json version must be a core semver string without leading zeros");
  }

  pluginJson.version = packageJson.version;
  await writeFile(pluginPath, `${JSON.stringify(pluginJson, null, 2)}\n`);
  console.log(`synced plugin.json to ${packageJson.version}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
