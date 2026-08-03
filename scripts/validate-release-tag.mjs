import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const packageJson = JSON.parse(await readFile(path.join(repositoryRoot, "package.json"), "utf8"));
const tag = process.argv[2];

if (!tag) throw Error("Usage: node scripts/validate-release-tag.mjs <tag>");
if (!/^v\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(tag)) throw Error(`Invalid release tag: ${tag}`);
if (tag !== `v${packageJson.version}`) {
  throw Error(`Release tag ${tag} does not match package version v${packageJson.version}`);
}

console.log(`${packageJson.name}@${packageJson.version}`);
