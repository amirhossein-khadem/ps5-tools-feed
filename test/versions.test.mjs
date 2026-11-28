import assert from "node:assert/strict";
import { test } from "node:test";
import { compareVersions, isVersion } from "../scripts/versions.mjs";

test("numeric versions use Payload Manager ordering", () => {
  assert.equal(compareVersions("v1.10", "v1.9", "numeric"), 1);
  assert.equal(compareVersions("v1.2", "v1.2.0", "numeric"), -1);
  assert.equal(compareVersions("V01.02", "1.2", "numeric"), 0);
});

test("numbered tests and betas use numeric suffixes", () => {
  const scheme = "numbered-prerelease";
  assert.equal(compareVersions("1.15-dr-test4", "1.15-dr-test3", scheme), 1);
  assert.equal(compareVersions("1.15-dr-test10", "1.15-dr-test9", scheme), 1);
  assert.equal(compareVersions("1.15beta9", "1.15-beta10", scheme), -1);
  assert.equal(compareVersions("1.15-BETA-01", "v1.15beta1", scheme), 0);
  assert.equal(compareVersions("1.15-preview-test", "1.15-preview-test1", scheme), -1);
});

test("a stable tag follows a pre-release on the same base version", () => {
  const scheme = "numbered-prerelease";
  assert.equal(compareVersions("1.15", "1.15-test99", scheme), 1);
  assert.equal(compareVersions("1.15-beta2", "1.15-test1", scheme), -1);
  assert.equal(compareVersions("1.16-alpha1", "1.15", scheme), 1);
});

test("version schemes reject malformed tags and numeric rejects suffixes", () => {
  for (const tag of [undefined, "latest", "v1", "v1.2.3.4.5", "v1.2+abc", "v1.2-beta1.zip", "v1.2\n"]) {
    assert.equal(isVersion(tag, "numbered-prerelease"), false, String(tag));
  }
  assert.equal(isVersion("v1.2-test4", "numeric"), false);
  assert.throws(() => compareVersions("not-a-tag", "v1.2", "numeric"), /Unsupported/);
});
