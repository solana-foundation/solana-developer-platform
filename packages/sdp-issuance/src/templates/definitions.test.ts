import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { resolveTemplateConfig } from "./definitions";

// The ConfidentialTransferMint extension is set at InitializeMint and can never
// be added afterwards, so a request that names it must survive the whole path
// from the API body to the persisted token — silently dropping it produces a
// mint that can never be fixed.
describe("resolveTemplateConfig — confidentialTransfers", () => {
  it("carries a confidentialTransfers override into the resolved extensions", () => {
    const resolved = resolveTemplateConfig("custom", {
      extensions: {
        confidentialTransfers: {
          policy: "opt-in",
          auditorElgamalPubkey: "So11111111111111111111111111111111111111112",
        },
      },
    });

    assert.deepEqual(resolved.errors, []);
    assert.deepEqual(resolved.extensions?.confidentialTransfers, {
      policy: "opt-in",
      auditorElgamalPubkey: "So11111111111111111111111111111111111111112",
    });
  });

  it("allows the override on the templates that already carry the extension", () => {
    for (const template of ["stablecoin", "tokenized-security"] as const) {
      const resolved = resolveTemplateConfig(template, {
        extensions: { confidentialTransfers: { policy: "whitelist" } },
      });
      assert.deepEqual(resolved.errors, [], template);
      assert.equal(resolved.extensions?.confidentialTransfers?.policy, "whitelist", template);
    }
  });

  // Arcade has no confidential support in the mosaic template, so accepting the
  // override here would deploy a mint that silently lacks it.
  it("rejects the override on the arcade template", () => {
    const resolved = resolveTemplateConfig("arcade", {
      extensions: { confidentialTransfers: { policy: "opt-in" } },
    });

    assert.equal(resolved.errors.length, 1);
    assert.equal(resolved.errors[0]?.code, "EXTENSION_NOT_ALLOWED");
    assert.equal(resolved.errors[0]?.extension, "confidentialTransfers");
  });

  it("leaves the extension off when it was never requested", () => {
    const resolved = resolveTemplateConfig("custom", {});
    assert.equal(resolved.extensions?.confidentialTransfers, undefined);
  });
});
