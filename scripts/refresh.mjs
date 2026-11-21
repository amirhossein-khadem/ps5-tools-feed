import { readFile, writeFile } from "node:fs/promises";

const publishers = new Map([
  ["ps5-account-tools", "MangoScango/ps5-account-tools"],
  ["fc27-squad-updater", "imanrep/fc27squadupdater"],
]);
const heartbeatMs = 7 * 24 * 60 * 60 * 1000;

function versionParts(tag) {
  if (typeof tag !== "string" || !/^v?\d{1,5}(?:\.\d{1,5}){1,3}$/.test(tag)) {
    throw new Error("Unsupported stable release tag");
  }
  return tag.replace(/^v/, "").split(".").map(Number);
}

function compareVersions(newTag, oldTag) {
  const next = versionParts(newTag);
  const previous = versionParts(oldTag);
  for (let part = 0; part < 4; part++) {
    const delta = (next[part] ?? 0) - (previous[part] ?? 0);
    if (delta !== 0) return delta;
  }
  return 0;
}

async function fetchPublisherRelease(previous) {
  const { id } = previous;
  const repository = publishers.get(id);
  const response = await fetch(`https://api.github.com/repos/${repository}/releases/latest`, {
    headers: { Accept: "application/vnd.github+json", "User-Agent": "PS5-Tools-Feed/1.0" },
    redirect: "error",
    signal: AbortSignal.timeout(15000),
  });
  if (!response.ok) throw new Error(`GitHub returned HTTP ${response.status}`);

  const release = await response.json();
  if (release.draft !== false || release.prerelease !== false || !Array.isArray(release.assets)) {
    throw new Error("No valid stable release");
  }
  const version = release.tag_name;
  const versionDelta = compareVersions(version, previous.version);
  if (versionDelta < 0) throw new Error("Publisher latest tag is older than the verified version");

  const digits = version.replace(/^v/, "");
  const names = new Set([`${id}.elf`, `${id}-v${digits}.elf`, `${id}-${digits}.elf`]);
  const assets = release.assets.filter((asset) => names.has(asset.name) && asset.state === "uploaded");
  if (assets.length !== 1) throw new Error("Expected one matching ELF asset");
  const asset = assets[0];
  if (typeof asset.digest !== "string" || !/^sha256:[a-f0-9]{64}$/i.test(asset.digest)) {
    throw new Error("Publisher asset SHA-256 is missing");
  }
  const checksum = asset.digest.slice(7).toLowerCase();
  if (versionDelta === 0 && checksum !== previous.checksum) {
    throw new Error("An existing release version changed SHA-256");
  }
  if (typeof release.published_at !== "string" || !/^\d{4}-\d{2}-\d{2}T/.test(release.published_at)) {
    throw new Error("Publisher release date is missing");
  }
  const url = `https://github.com/${repository}/releases/download/${version}/${asset.name}`;
  if (url !== asset.browser_download_url) throw new Error("Unexpected release asset URL");

  return { ...previous, filename: asset.name, url, checksum, version, last_update: release.published_at.slice(0, 10) };
}

const catalogFile = new URL("../payloads.json", import.meta.url);
const previous = JSON.parse(await readFile(catalogFile, "utf8"));
if (!Array.isArray(previous.payloads) || previous.payloads.length !== publishers.size ||
    new Set(previous.payloads.map(({ id }) => id)).size !== publishers.size ||
    previous.payloads.some(({ id }) => !publishers.has(id))) {
  throw new Error("The catalog must contain exactly the two approved publisher IDs");
}

const results = await Promise.allSettled(previous.payloads.map(fetchPublisherRelease));
const payloads = results.map((result, index) => {
  if (result.status === "fulfilled") {
    console.log(`Verified ${result.value.id} ${result.value.version}`);
    return result.value;
  }
  console.warn(`Retaining ${previous.payloads[index].id}: ${result.reason.message}`);
  return previous.payloads[index];
});
const verified = results.filter((result) => result.status === "fulfilled").length;
if (verified === 0) throw new Error("Neither publisher could be verified");

const next = { ...previous, payloads };
const entriesChanged = JSON.stringify(previous.payloads) !== JSON.stringify(payloads);
const lastVerified = Date.parse(previous.last_verified_at);
// GitHub pauses scheduled workflows on inactive public repositories. Record a successful check weekly.
if (verified === publishers.size && (entriesChanged || !(Date.now() - lastVerified < heartbeatMs))) {
  next.last_verified_at = new Date().toISOString();
}
if (entriesChanged || next.last_verified_at !== previous.last_verified_at) {
  await writeFile(catalogFile, JSON.stringify(next, null, 2) + "\n", "utf8");
}
