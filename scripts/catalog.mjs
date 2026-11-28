import { createHash } from "node:crypto";
import { compareVersions, isVersion, versionSchemes } from "./versions.mjs";

const idPattern = /^[a-z0-9._-]+$/;
const repositoryPattern = /^[a-z0-9-]+\/(?!\.{1,2}$)[a-z0-9._-]+$/i;
const filenamePattern = /^[a-z0-9._-]+\.elf$/i;
const templatePattern = /^(?:[a-zA-Z0-9._-]|\{tag\}|\{version\})+\.[eE][lL][fF]$/;
const sha256Pattern = /^[a-f0-9]{64}$/i;
const heartbeatMs = 7 * 24 * 60 * 60 * 1000;
const maxPayloadBytes = 512 * 1024 * 1024;
const elfMagic = Buffer.from([0x7f, 0x45, 0x4c, 0x46]);

function hasText(value) {
  return typeof value === "string" && value.trim().length !== 0;
}

function isHttpsUrl(value) {
  if (typeof value !== "string" || !value.startsWith("https://")) return false;
  try {
    const url = new URL(value);
    return Boolean(url.hostname && !url.username && !url.password);
  } catch {
    return false;
  }
}

function isDate(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString().slice(0, 10) === value;
}

function publisherIndex(settings) {
  if (!Array.isArray(settings) || settings.length === 0) {
    throw new Error("publishers.json must contain at least one publisher");
  }
  const publishers = new Map();
  for (const publisher of settings) {
    const { id, name, repository, assetNames, releasePolicy, versionScheme } = publisher ?? {};
    if (typeof id !== "string" || !idPattern.test(id) || publishers.has(id)) {
      throw new Error("Publisher IDs must be valid and unique");
    }
    if (!hasText(name) || typeof repository !== "string" || !repositoryPattern.test(repository)) {
      throw new Error(`Invalid name or GitHub repository for ${id}`);
    }
    if (!versionSchemes.has(versionScheme) ||
        !["stable", "prerelease"].includes(releasePolicy) ||
        (releasePolicy === "prerelease" && versionScheme === "numeric")) {
      throw new Error(`Invalid version scheme or release policy for ${id}`);
    }
    if (!Array.isArray(assetNames) || assetNames.length === 0 ||
        assetNames.some((name) => typeof name !== "string" || !templatePattern.test(name))) {
      throw new Error(`Invalid ELF filename templates for ${id}`);
    }
    for (const field of ["category", "author", "description"]) {
      if (publisher[field] !== undefined && typeof publisher[field] !== "string") {
        throw new Error(`Invalid ${field} for ${id}`);
      }
    }
    publishers.set(id, publisher);
  }
  return publishers;
}

function catalogIndex(catalog, publishers) {
  if (!hasText(catalog?.name) || !Array.isArray(catalog.payloads)) {
    throw new Error("payloads.json must contain a name and a payloads array");
  }
  const entries = new Map();
  for (const entry of catalog.payloads) {
    const publisher = publishers.get(entry?.id);
    if (!publisher || entries.has(entry.id)) {
      throw new Error("Catalog IDs must be unique and defined in publishers.json");
    }
    if (!hasText(entry.name) || typeof entry.filename !== "string" ||
        !filenamePattern.test(entry.filename) || !isHttpsUrl(entry.url) ||
        typeof entry.checksum !== "string" || !sha256Pattern.test(entry.checksum) ||
        !isVersion(entry.version, publisher.versionScheme) || !isDate(entry.last_update)) {
      throw new Error(`Invalid verified entry for ${entry.id}`);
    }
    entries.set(entry.id, entry);
  }
  return entries;
}

function isAllowedTag(tag, publisher) {
  return isVersion(tag, publisher.versionScheme) &&
    isVersion(tag, "numeric") === (publisher.releasePolicy === "stable");
}

function expectedNames(publisher, tag) {
  const version = tag.replace(/^v/i, "");
  return new Set(publisher.assetNames.map((name) =>
    name.replaceAll("{tag}", tag).replaceAll("{version}", version)));
}

function matchingAssets(release, publisher) {
  if (!Array.isArray(release.assets)) return [];
  const names = expectedNames(publisher, release.tag_name);
  return release.assets.filter((asset) => names.has(asset?.name));
}

async function requestGitHub(url, fetcher) {
  const response = await fetcher(url, {
    headers: { Accept: "application/vnd.github+json", "User-Agent": "PS5-Tools-Feed/1.0" },
    redirect: "error",
    signal: AbortSignal.timeout(15000),
  });
  if (!response.ok) throw new Error(`GitHub returned HTTP ${response.status}`);
  return response;
}

async function latestPrerelease(endpoint, publisher, fetcher) {
  const eligible = [];
  let response;
  let page = 1;
  do {
    response = await requestGitHub(`${endpoint}?per_page=100&page=${page++}`, fetcher);
    const releases = await response.json();
    if (!Array.isArray(releases)) throw new Error("Invalid GitHub release list");
    eligible.push(...releases.filter((release) =>
      release?.draft === false && release.prerelease === true &&
      isAllowedTag(release.tag_name, publisher) && matchingAssets(release, publisher).length !== 0));
  } while (/\brel="next"/.test(response.headers.get("link") ?? ""));

  const compare = (a, b) => compareVersions(a.tag_name, b.tag_name, publisher.versionScheme);
  eligible.sort((a, b) => compare(b, a));
  if (eligible.length > 1 && compare(eligible[0], eligible[1]) === 0) {
    throw new Error("Multiple pre-release tags compare equal to the newest version");
  }
  return eligible[0];
}

async function officialRelease(publisher, fetcher) {
  const { repository, releasePolicy } = publisher;
  const endpoint = `https://api.github.com/repos/${repository}/releases`;
  const release = releasePolicy === "stable"
    ? await (await requestGitHub(`${endpoint}/latest`, fetcher)).json()
    : await latestPrerelease(endpoint, publisher, fetcher);
  if (release?.draft !== false || release.prerelease !== (releasePolicy === "prerelease") ||
      !isAllowedTag(release.tag_name, publisher)) {
    throw new Error(`No valid ${releasePolicy} release`);
  }

  const assets = matchingAssets(release, publisher).filter((asset) => asset.state === "uploaded");
  if (assets.length !== 1) throw new Error("Expected one matching uploaded ELF asset");
  const { name: filename, digest, browser_download_url: url } = assets[0];
  if (typeof digest !== "string" || !/^sha256:[a-f0-9]{64}$/i.test(digest)) {
    throw new Error("Publisher asset SHA-256 is missing or invalid");
  }
  const version = release.tag_name;
  const source = `https://github.com/${repository}/releases`;
  if (url !== `${source}/download/${version}/${filename}`) {
    throw new Error("Unexpected release asset URL");
  }
  const publishedAt = release.published_at;
  if (typeof publishedAt !== "string" || !/^\d{4}-\d{2}-\d{2}T/.test(publishedAt) ||
      !isDate(publishedAt.slice(0, 10)) || !Number.isFinite(Date.parse(publishedAt))) {
    throw new Error("Publisher release date is missing or invalid");
  }
  return {
    filename, url, checksum: digest.slice(7).toLowerCase(), version,
    last_update: publishedAt.slice(0, 10), source,
  };
}

function manualRelease(publisher) {
  if (publisher.manualRelease === undefined) return undefined;
  const { filename, url, checksum, version, last_update, source } = publisher.manualRelease ?? {};
  if (!isAllowedTag(version, publisher) || !expectedNames(publisher, version).has(filename) ||
      !isDate(last_update) || !isHttpsUrl(url) || !isHttpsUrl(source) ||
      source === url || typeof checksum !== "string" || !sha256Pattern.test(checksum)) {
    throw new Error("Invalid manual release approval");
  }
  return { filename, url, checksum: checksum.toLowerCase(), version, last_update, source };
}

async function verifyManualDownload(candidate, fetcher) {
  const signal = AbortSignal.timeout(45000);
  let url = candidate.url;
  let response;
  for (let redirects = 0; ; redirects++) {
    response = await fetcher(url, { redirect: "manual", signal });
    if (![301, 302, 303, 307, 308].includes(response.status)) break;
    await response.body?.cancel();
    const location = response.headers.get("location");
    if (!location || redirects === 5) throw new Error("Invalid manual download redirect");
    url = new URL(location, url).href;
    if (!isHttpsUrl(url)) throw new Error("Manual download redirect must use HTTPS");
  }
  if (!response.ok || !response.body) throw new Error(`Manual download returned HTTP ${response.status}`);

  const hash = createHash("sha256");
  let bytes = 0;
  let header = Buffer.alloc(0);
  for await (const chunk of response.body) {
    bytes += chunk.length;
    if (bytes > maxPayloadBytes) throw new Error("Manual ELF exceeds Payload Manager's size limit");
    hash.update(chunk);
    if (header.length < elfMagic.length) {
      header = Buffer.concat([header, chunk.subarray(0, elfMagic.length - header.length)]);
    }
  }
  if (!header.equals(elfMagic)) throw new Error("Manual download is missing the ELF signature");
  if (hash.digest("hex") !== candidate.checksum) throw new Error("Manual download SHA-256 mismatch");
}

async function refreshPublisher(publisher, previous, fetcher) {
  const manual = manualRelease(publisher);
  let official;
  try {
    official = await officialRelease(publisher, fetcher);
  } catch (error) {
    if (!manual) throw error;
  }

  const compare = (a, b) => compareVersions(a.version, b.version, publisher.versionScheme);
  const delta = manual && official ? compare(manual, official) : 0;
  if (manual && official && delta === 0 && manual.checksum !== official.checksum) {
    throw new Error("Manual and official SHA-256 differ for the same version");
  }
  const candidate = delta > 0 || !official ? manual : official;
  if (previous) {
    const versionDelta = compare(candidate, previous);
    if (versionDelta < 0) throw new Error("Release is older than the verified version");
    if (versionDelta === 0) {
      if (candidate.checksum !== previous.checksum.toLowerCase()) {
        throw new Error("An existing release version changed SHA-256");
      }
      return previous;
    }
  }

  if (candidate === manual) await verifyManualDownload(manual, fetcher);
  const { id, name, category, author, description } = publisher;
  return { ...previous, id, name, ...candidate, category, author, description };
}

export async function refreshCatalog(previous, settings, {
  fetcher = globalThis.fetch,
  now = new Date(),
} = {}) {
  const publishers = publisherIndex(settings);
  const verified = catalogIndex(previous, publishers);
  const ids = [...new Set([...verified.keys(), ...publishers.keys()])];
  const results = await Promise.allSettled(ids.map((id) =>
    refreshPublisher(publishers.get(id), verified.get(id), fetcher)));

  const payloads = results.map((result, index) => result.status === "fulfilled"
    ? result.value
    : verified.get(ids[index])).filter(Boolean);
  const entriesChanged = payloads.length !== previous.payloads.length ||
    payloads.some((entry, index) => entry !== previous.payloads[index]);
  const allVerified = results.every(({ status }) => status === "fulfilled");
  const needsHeartbeat = !(now.getTime() - Date.parse(previous.last_verified_at) < heartbeatMs);

  const catalog = entriesChanged ? { ...previous, payloads } : previous;
  // A successful weekly check keeps the public repository's scheduled workflow active.
  return {
    catalog: allVerified && (entriesChanged || needsHeartbeat)
      ? { ...catalog, last_verified_at: now.toISOString() }
      : catalog,
    results: results.map((result, index) => ({ ...result, id: ids[index] })),
  };
}
