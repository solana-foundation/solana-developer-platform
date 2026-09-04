import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..");
const manifest = JSON.parse(
  fs.readFileSync(path.resolve(repoRoot, ".github/vendor-assets.json"), "utf8")
);

test("every manifest entry is a well-formed https asset pin", () => {
  assert.ok(Array.isArray(manifest) && manifest.length > 0);
  for (const entry of manifest) {
    assert.match(entry.name, /^[a-z0-9-]+$/, `name: ${entry.name}`);
    assert.match(entry.url, /^https:\/\//, `url: ${entry.url}`);
    assert.match(entry.sha256, /^[0-9a-f]{64}$/, `sha256: ${entry.sha256}`);
    assert.ok(
      fs.existsSync(path.resolve(repoRoot, entry.pinnedIn)),
      `pinnedIn does not exist: ${entry.pinnedIn}`
    );
  }
});

test("the moneygram-sdk entry matches the pin and upstream URL in the code", () => {
  const entry = manifest.find((asset) => asset.name === "moneygram-sdk");
  assert.ok(entry, "manifest is missing the moneygram-sdk entry");

  const pinSource = fs.readFileSync(
    path.resolve(repoRoot, "apps/sdp-web/src/lib/moneygram-sdk.ts"),
    "utf8"
  );
  const pinned = pinSource.match(/MONEYGRAM_SDK_VERSION =\s*"([0-9a-f]{64})"/);
  assert.ok(pinned, "could not read MONEYGRAM_SDK_VERSION from moneygram-sdk.ts");
  assert.equal(entry.sha256, pinned[1]);

  const routeSource = fs.readFileSync(
    path.resolve(repoRoot, "apps/sdp-web/src/app/api/vendor/moneygram/sdk/[version]/route.ts"),
    "utf8"
  );
  const upstream = routeSource.match(/MONEYGRAM_SDK_UPSTREAM_URL = "([^"]+)"/);
  assert.ok(upstream, "could not read MONEYGRAM_SDK_UPSTREAM_URL from the vendor route");
  assert.equal(entry.url, upstream[1]);
});
