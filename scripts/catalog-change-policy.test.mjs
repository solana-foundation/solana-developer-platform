import assert from "node:assert/strict";
import test from "node:test";
import { checkCatalogChangePolicy } from "../.github/scripts/check-catalog-change-policy.mjs";

test("allows product PRs that change only English source catalogs", () => {
  const result = checkCatalogChangePolicy({
    changedFiles: ["apps/sdp-web/messages/en/shared.json", "apps/sdp-web/src/app/page.tsx"],
    headBranch: "feat/new-copy",
  });

  assert.equal(result.mode, "source-only");
});

test("allows dedicated translation PRs with no English catalog changes", () => {
  const result = checkCatalogChangePolicy({
    changedFiles: ["apps/sdp-web/messages/fr/shared.json", ".github/translation-guidance.json"],
    headBranch: "codex/french-translation-quality",
  });

  assert.equal(result.mode, "translation-only");
});

test("rejects product PRs that update English and localized catalogs together", () => {
  assert.throws(
    () =>
      checkCatalogChangePolicy({
        changedFiles: [
          "apps/sdp-web/messages/en/shared.json",
          "apps/sdp-web/messages/fr/shared.json",
        ],
        headBranch: "feat/new-copy",
      }),
    /must change only English source catalogs/
  );
});

test("allows the automated release branch to synchronize translations", () => {
  const result = checkCatalogChangePolicy({
    changedFiles: ["apps/sdp-web/messages/en/shared.json", "apps/sdp-web/messages/fr/shared.json"],
    headBranch: "codex/release-main",
    headRepository: "solana-foundation/solana-developer-platform",
    baseRepository: "solana-foundation/solana-developer-platform",
  });

  assert.equal(result.mode, "automated-release");
});

test("rejects a fork that spoofs the automated release branch name", () => {
  assert.throws(
    () =>
      checkCatalogChangePolicy({
        changedFiles: [
          "apps/sdp-web/messages/en/shared.json",
          "apps/sdp-web/messages/fr/shared.json",
        ],
        headBranch: "codex/release-main",
        headRepository: "contributor/solana-developer-platform",
        baseRepository: "solana-foundation/solana-developer-platform",
      }),
    /must change only English source catalogs/
  );
});

test("rejects an unverified automated release branch", () => {
  assert.throws(
    () =>
      checkCatalogChangePolicy({
        changedFiles: [
          "apps/sdp-web/messages/en/shared.json",
          "apps/sdp-web/messages/fr/shared.json",
        ],
        headBranch: "codex/release-main",
      }),
    /must change only English source catalogs/
  );
});
