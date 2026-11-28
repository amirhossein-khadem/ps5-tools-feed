import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { refreshCatalog } from "../scripts/catalog.mjs";

const publishedAt = "2026-01-12T12:00:00Z";
const now = new Date("2026-01-13T12:00:00Z");
const catalog = { name: "Test catalog", payloads: [], last_verified_at: publishedAt };
const stable = {
  id: "example-tool",
  name: "Example Tool",
  repository: "example-owner/example-tool",
  assetNames: ["example-tool.elf", "example-tool-v{version}.elf"],
  releasePolicy: "stable",
  versionScheme: "numeric",
};
const preview = {
  ...stable,
  id: "example-preview",
  name: "Example Preview",
  repository: "example-owner/example-preview",
  assetNames: ["example-preview-{tag}.elf"],
  releasePolicy: "prerelease",
  versionScheme: "numbered-prerelease",
};

const elf = Buffer.from("\x7fELF Example Tool test bytes");
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const release = (publisher, tag, filename, checksum = sha256(elf)) => ({
  tag_name: tag,
  draft: false,
  prerelease: publisher.releasePolicy === "prerelease",
  published_at: publishedAt,
  assets: [{
    name: filename,
    state: "uploaded",
    digest: `sha256:${checksum}`,
    browser_download_url: `https://github.com/${publisher.repository}/releases/download/${tag}/${filename}`,
  }],
});
const stableRelease = release(stable, "v1.9", "example-tool.elf");
const approved = {
  version: "v1.10",
  filename: "example-tool-v1.10.elf",
  url: "https://downloads.example.test/tool.elf",
  source: "https://publisher.example.test/announcement",
  checksum: sha256(elf),
  last_update: "2026-01-12",
};

async function refreshStable(input = stableRelease, previous = catalog) {
  return refreshCatalog(previous, [stable], {
    now,
    fetcher: async (url) => {
      assert.equal(url, `https://api.github.com/repos/${stable.repository}/releases/latest`);
      return Response.json(input);
    },
  });
}

test("the two existing tools still use the official stable endpoints and verified rows", async () => {
  const existingIds = ["ps5-account-tools", "fc27-squad-updater"];
  const [current, config] = await Promise.all(
    ["payloads.json", "publishers.json"].map(async (name) =>
      JSON.parse(await readFile(new URL(`../${name}`, import.meta.url), "utf8"))),
  );
  const settings = config.filter(({ id }) => existingIds.includes(id));
  const previous = {
    ...current,
    payloads: current.payloads.filter(({ id }) => existingIds.includes(id)),
    last_verified_at: publishedAt,
  };
  assert.deepEqual(previous.payloads.map(({ id }) => id), existingIds);
  const requests = new Set();
  const result = await refreshCatalog(previous, settings, {
    now,
    fetcher: async (url) => {
      requests.add(url);
      const publisher = settings.find(({ repository }) =>
        url === `https://api.github.com/repos/${repository}/releases/latest`);
      const entry = previous.payloads.find(({ id }) => id === publisher.id);
      const response = release(publisher, entry.version, entry.filename, entry.checksum);
      response.published_at = `${entry.last_update}T12:00:00Z`;
      assert.equal(response.assets[0].browser_download_url, entry.url);
      return Response.json(response);
    },
  });
  assert.equal(requests.size, 2);
  assert.ok(result.results.every(({ status }) => status === "fulfilled"));
  assert.equal(result.catalog, previous);
});

test("a configured tool is discovered without seeding payloads.json", async () => {
  const output = await refreshStable();
  const [entry] = output.catalog.payloads;
  assert.deepEqual(JSON.parse(JSON.stringify(output.catalog)), {
    name: catalog.name,
    last_verified_at: now.toISOString(),
    payloads: [{
      id: stable.id,
      name: stable.name,
      filename: stableRelease.assets[0].name,
      url: stableRelease.assets[0].browser_download_url,
      checksum: sha256(elf),
      version: stableRelease.tag_name,
      last_update: "2026-01-12",
      source: `https://github.com/${stable.repository}/releases`,
    }],
  });
  assert.equal(output.results[0].value, entry);
});

test("pre-release selection checks all pages, tags and exact filenames", async () => {
  const calls = [];
  const result = await refreshCatalog(catalog, [preview], {
    now,
    fetcher: async (url) => {
      const endpoint = `https://api.github.com/repos/${preview.repository}/releases?per_page=100`;
      calls.push(url);
      if (url === `${endpoint}&page=1`) {
        return Response.json([
          release(preview, "2.11-test9", "example-preview-2.11-test9.elf"),
          release(preview, "99.0-test1", "unrelated.elf"),
          { ...release(preview, "98.0-test1", "example-preview-98.0-test1.elf"), draft: true },
          { ...release(preview, "97.0", "example-preview-97.0.elf"), prerelease: false },
          release(preview, "96.0", "example-preview-96.0.elf"),
        ], { headers: { Link: `<${endpoint}&page=2>; rel="next"` } });
      }
      assert.equal(url, `${endpoint}&page=2`);
      return Response.json([release(preview, "2.11-test10", "example-preview-2.11-test10.elf")]);
    },
  });
  assert.equal(calls.length, 2);
  assert.equal(result.catalog.payloads[0].version, "2.11-test10");
});

test("an ambiguous newest pre-release leaves the catalog unchanged", async () => {
  const tagA = release(preview, "2.11-beta2", "example-preview-2.11-beta2.elf");
  const tagB = release(preview, "V2.11-BETA-02", "example-preview-V2.11-BETA-02.elf");
  const output = await refreshCatalog(catalog, [preview], {
    now,
    fetcher: async () => Response.json([tagA, tagB]),
  });
  assert.equal(output.catalog, catalog);
  assert.match(output.results[0].reason.message, /Multiple pre-release tags/);
});

test("downgrades and checksum changes at equal versions retain the verified entry", async () => {
  const { catalog: previous } = await refreshStable();
  const downgrade = await refreshStable(release(stable, "v1.8", "example-tool.elf"), previous);
  assert.equal(downgrade.catalog, previous);
  assert.match(downgrade.results[0].reason.message, /older/);
  const changed = await refreshStable(release(stable, "V1.09", "example-tool.elf", sha256("other")), previous);
  assert.equal(changed.catalog, previous);
  assert.match(changed.results[0].reason.message, /changed SHA-256/);
});

test("invalid official assets and policies fail closed", async (t) => {
  const { catalog: previous } = await refreshStable();
  const valid = release(stable, "v1.10", "example-tool.elf");
  const [asset] = valid.assets;
  const cases = [
    ["draft", { ...valid, draft: true }, /No valid/],
    ["pre-release", { ...valid, prerelease: true }, /No valid/],
    ["unsupported tag", { ...valid, tag_name: "v2.0-beta3" }, /No valid/],
    ["wrong upload state", { ...valid, assets: [{ ...asset, state: "open" }] }, /uploaded ELF/],
    ["duplicate assets", { ...valid, assets: [asset, asset] }, /uploaded ELF/],
    ["missing digest", { ...valid, assets: [{ ...asset, digest: null }] }, /SHA-256/],
    ["wrong URL", { ...valid, assets: [{ ...asset, browser_download_url: approved.url }] }, /unexpected/i],
    ["invalid date", { ...valid, published_at: "2026-02-31T12:00:00Z" }, /date/],
  ];
  for (const [name, input, message] of cases) {
    await t.test(name, async () => {
      const output = await refreshStable(input, previous);
      assert.equal(output.catalog, previous);
      assert.match(output.results[0].reason.message, message);
    });
  }
});

test("one publisher can update while another fails or has no verified release", async () => {
  const { catalog: previous } = await refreshStable();
  const output = await refreshCatalog(previous, [preview, stable], {
    now,
    fetcher: async (url) => url.endsWith("/latest")
      ? Response.json(release(stable, "v1.10", "example-tool-v1.10.elf"))
      : new Response(null, { status: 503 }),
  });
  assert.equal(output.catalog.payloads.length, 1);
  assert.equal(output.catalog.payloads[0].version, "v1.10");
  assert.equal(output.catalog.last_verified_at, previous.last_verified_at);
  assert.match(output.results[1].reason.message, /503/);
});

test("manual approval hashes the ELF, records its source and wins over an older official release", async () => {
  const calls = [];
  const output = await refreshCatalog(catalog, [{ ...stable, manualRelease: approved }], {
    now,
    fetcher: async (url, options) => {
      calls.push(url);
      if (url.endsWith("/latest")) return Response.json(stableRelease);
      assert.equal(options.redirect, "manual");
      if (url === approved.url) {
        return new Response(null, { status: 302, headers: { Location: "/file.elf" } });
      }
      assert.equal(url, "https://downloads.example.test/file.elf");
      return new Response(elf);
    },
  });
  assert.equal(calls.length, 3);
  assert.equal(output.catalog.payloads[0].version, approved.version);
  assert.equal(output.catalog.payloads[0].source, approved.source);
  assert.equal(output.catalog.payloads[0].checksum, approved.checksum);
  assert.equal(output.catalog.payloads[0].url, approved.url);
});

test("manual release requires provenance and matching ELF bytes", async (t) => {
  const { catalog: previous } = await refreshStable();
  const cases = [
    ["missing source", { ...approved, source: undefined }, new Response(elf), /approval/],
    ["different bytes", approved, new Response(Buffer.concat([elf, Buffer.from("changed")])), /mismatch/],
    ["non-ELF", { ...approved, checksum: sha256("text") }, new Response("text"), /ELF signature/],
    ["failed download", approved, new Response(null, { status: 404 }), /HTTP 404/],
    ["insecure redirect", approved, new Response(null, {
      status: 302, headers: { Location: "http://downloads.example.test/tool.elf" },
    }), /HTTPS/],
  ];
  for (const [name, manualRelease, response, message] of cases) {
    await t.test(name, async () => {
      const output = await refreshCatalog(previous, [{ ...stable, manualRelease }], {
        now,
        fetcher: async (url) => url.endsWith("/latest")
          ? new Response(null, { status: 404 })
          : response,
      });
      assert.equal(output.catalog, previous);
      assert.match(output.results[0].reason.message, message);
    });
  }
});

test("same-version disagreement between official and manual hashes stops publication", async () => {
  const output = await refreshCatalog(catalog, [{ ...stable, manualRelease: approved }], {
    now,
    fetcher: async () => Response.json(
      release(stable, approved.version, approved.filename, sha256("other")),
    ),
  });
  assert.equal(output.catalog, catalog);
  assert.match(output.results[0].reason.message, /Manual and official SHA-256 differ/);
});

test("a verified manual version stays when upstream offers an older version", async () => {
  const settings = [{ ...stable, manualRelease: approved }];
  const { catalog: previous } = await refreshCatalog(catalog, settings, {
    now,
    fetcher: async (url) => url.endsWith("/latest")
      ? new Response(null, { status: 404 })
      : new Response(elf),
  });
  assert.equal(previous.payloads[0].version, approved.version);
  const output = await refreshStable(stableRelease, previous);
  assert.equal(output.catalog, previous);
  assert.match(output.results[0].reason.message, /older/);
});

test("invalid publisher settings fail before network or catalog writes", async () => {
  const fetcher = async () => assert.fail("a bad registry triggered a network request");
  await assert.rejects(refreshCatalog(catalog, [stable, stable], { fetcher }), /unique/);
  await assert.rejects(refreshCatalog(catalog, [{ ...stable, repository: "other/../repo" }], { fetcher }), /repository/);
  await assert.rejects(refreshCatalog(catalog, [{ ...stable, assetNames: ["*.elf"] }], { fetcher }), /templates/);
  await assert.rejects(refreshCatalog(catalog, [{ ...preview, versionScheme: "numeric" }], { fetcher }), /policy/);
});

test("a weekly heartbeat preserves all verified rows", async () => {
  const { catalog: previous } = await refreshStable();
  const nextWeek = new Date("2026-01-20T12:00:00Z");
  const output = await refreshCatalog(previous, [stable], {
    now: nextWeek,
    fetcher: async () => Response.json(stableRelease),
  });
  assert.deepEqual(output.catalog.payloads, previous.payloads);
  assert.equal(output.catalog.last_verified_at, nextWeek.toISOString());
});
