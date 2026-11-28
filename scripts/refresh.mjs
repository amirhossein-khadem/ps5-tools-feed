import { open, readFile, rename, rm } from "node:fs/promises";
import { refreshCatalog } from "./catalog.mjs";

const catalogFile = new URL("../payloads.json", import.meta.url);
const configFile = new URL("../publishers.json", import.meta.url);
const stagingFile = new URL("../.payloads.json.tmp", import.meta.url);

async function writeCatalog(catalog, original) {
  const staging = await open(stagingFile, "wx");
  try {
    try {
      if (await readFile(catalogFile, "utf8") !== original) {
        throw new Error("payloads.json changed during refresh. Run the refresh again.");
      }
      await staging.writeFile(JSON.stringify(catalog, null, 2) + "\n", "utf8");
    } finally {
      await staging.close();
    }
    await rename(stagingFile, catalogFile);
  } catch (error) {
    await rm(stagingFile, { force: true });
    throw error;
  }
}

const options = process.argv.slice(2);
const checkOnly = options.length === 1 && options[0] === "--check";
if (options.length !== 0 && !checkOnly) {
  throw new Error("Usage: node scripts/refresh.mjs [--check]");
}

const [original, config] = await Promise.all([
  readFile(catalogFile, "utf8"),
  readFile(configFile, "utf8"),
]);
const previous = JSON.parse(original);
const { catalog, results } = await refreshCatalog(previous, JSON.parse(config));
const failures = results.filter(({ status }) => status === "rejected");
for (const result of results) {
  if (result.status === "fulfilled") {
    console.log(`Verified ${result.id} ${result.value.version}`);
  } else {
    console.warn(`No update for ${result.id}: ${result.reason.message}`);
  }
}
if (failures.length === results.length || (checkOnly && failures.length !== 0)) {
  throw new Error("Publisher verification failed");
}
if (checkOnly) {
  console.log(catalog === previous ? "Catalog is current" : "Catalog changes are ready");
} else if (catalog !== previous) {
  await writeCatalog(catalog, original);
}
