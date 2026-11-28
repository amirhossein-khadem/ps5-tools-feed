const numericTag = /^v?\d{1,5}(?:\.\d{1,5}){1,3}$/i;
const prereleaseTag = /^v?\d{1,5}(?:\.\d{1,5}){1,3}(?:(?:-[a-z]{1,16}-|[-._]?)(?:alpha|beta|rc|test)(?:[-._]?\d{1,5})?)?$/i;
export const versionSchemes = new Map([
  ["numeric", numericTag],
  ["numbered-prerelease", prereleaseTag],
]);

export function isVersion(tag, scheme) {
  return typeof tag === "string" && versionSchemes.get(scheme)?.test(tag) === true;
}

function tokens(tag, scheme) {
  if (!isVersion(tag, scheme)) throw new Error(`Unsupported ${scheme} version: ${tag}`);
  return tag.toLowerCase().replace(/^v/, "").match(/[a-z]+|\d+/g)
    .map((part) => /\d/.test(part) ? Number(part) : part);
}

// Keep the order of supported tags consistent with PS5 Payload Manager.
export function compareVersions(newTag, oldTag, scheme) {
  const next = tokens(newTag, scheme);
  const previous = tokens(oldTag, scheme);
  for (let index = 0; index < Math.max(next.length, previous.length); index++) {
    const a = next[index];
    const b = previous[index];
    if (a === b) continue;
    if (a === undefined) return typeof b === "number" ? -1 : 1;
    if (b === undefined) return typeof a === "number" ? 1 : -1;
    if (typeof a !== typeof b) return typeof a === "number" ? 1 : -1;
    return a < b ? -1 : 1;
  }
  return 0;
}
