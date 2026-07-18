import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import { ASSET_TYPES } from "@sdp/types";

import {
  ADVANCED_SETTINGS,
  ADVANCED_SETTINGS_VERSION,
  ASSET_CAPABILITIES,
  getRecommendedSettings,
  isSettingAllowed,
  listSettingsForType,
  renderSupportMatrixMarkdown,
  resolveAssetCapability,
  resolveSettingsToExtensions,
  SETTING_KEYS,
  validateSelectedSettings,
} from "./index";

describe("advanced settings capability registry", () => {
  it("loads without throwing the dev-time completeness assertion", () => {
    // Importing ./index runs the assertion (NODE_ENV !== 'production'); if the
    // registry drifted, the import above would already have thrown.
    assert.ok(ASSET_CAPABILITIES.length > 0);
    assert.ok(SETTING_KEYS.length > 0);
  });

  it("has exactly one capability entry for every ASSET_TYPES pair", () => {
    for (const category of Object.keys(ASSET_TYPES) as Array<keyof typeof ASSET_TYPES>) {
      for (const type of ASSET_TYPES[category]) {
        const matches = ASSET_CAPABILITIES.filter(
          (c) => c.category === category && c.type === type
        );
        assert.equal(matches.length, 1, `expected one capability for ${category}/${type}`);
      }
    }
  });

  it("rejects an unsupported setting (nonTransferable on a stablecoin)", () => {
    assert.equal(isSettingAllowed("stablecoin", "fiat_backed", "nonTransferable"), false);
    // ...but allows it on a generic asset.
    assert.equal(isSettingAllowed("generic", "collectible", "nonTransferable"), true);
  });

  it("returns false for unknown pairs and unknown settings", () => {
    assert.equal(isSettingAllowed("stablecoin", "not_a_type", "freezeTransfers"), false);
    assert.equal(isSettingAllowed("stablecoin", "fiat_backed", "not_a_setting"), false);
    assert.equal(resolveAssetCapability("generic", "not_a_type"), undefined);
    assert.deepEqual(getRecommendedSettings("generic", "not_a_type"), []);
  });

  it("recommends the expected defaults per asset type", () => {
    const stablecoin = getRecommendedSettings("stablecoin", "fiat_backed");
    assert.ok(stablecoin.includes("freezeTransfers"));
    assert.ok(stablecoin.includes("permanentDelegate"));

    // securities additionally recommend scaledUiAmount (in their template).
    assert.ok(getRecommendedSettings("tokenized_security", "debt").includes("scaledUiAmount"));

    // generic assets force nothing on.
    assert.deepEqual(getRecommendedSettings("generic", "generic"), []);
  });

  it("lists settings for a type without the unsupported ones", () => {
    const grouped = listSettingsForType("stablecoin", "fiat_backed");
    const keys = grouped.map((g) => g.key);
    assert.ok(!keys.includes("nonTransferable"), "unsupported setting must be hidden");
    assert.ok(!keys.includes("interestBearing"), "fiat peg does not bear interest");
    // every listed setting resolves to a real catalog entry with jargon-free copy.
    for (const entry of grouped) {
      assert.equal(entry.setting, ADVANCED_SETTINGS[entry.key]);
      assert.match(entry.setting.labelKey, /^DashboardIssuance\.config\./);
    }
  });

  it("validates a selection against a type's capability", () => {
    // all-allowed selection ⇒ no errors.
    assert.deepEqual(
      validateSelectedSettings("stablecoin", "fiat_backed", [
        "freezeTransfers",
        "permanentDelegate",
      ]),
      []
    );
    // unknown key and unsupported key are reported with their reasons.
    assert.deepEqual(
      validateSelectedSettings("stablecoin", "fiat_backed", ["nonTransferable", "made_up"]),
      [
        { settingKey: "nonTransferable", reason: "unsupported" },
        { settingKey: "made_up", reason: "unknown" },
      ]
    );
    // an unknown asset type rejects every key as unsupported.
    assert.deepEqual(validateSelectedSettings("stablecoin", "not_a_type", ["freezeTransfers"]), [
      { settingKey: "freezeTransfers", reason: "unsupported" },
    ]);
  });

  it("exposes a positive settings version for persistence stamping", () => {
    assert.ok(Number.isInteger(ADVANCED_SETTINGS_VERSION) && ADVANCED_SETTINGS_VERSION > 0);
  });

  it("resolves a selection into a deployment-ready extension config", () => {
    // generic → custom substrate: a parametric setting maps into the config.
    const generic = resolveSettingsToExtensions("generic", "generic", {
      transferFee: { params: { basisPoints: 50, maxFee: "100" } },
    });
    assert.deepEqual(generic.errors, []);
    assert.equal(generic.extensions?.transferFee?.basisPoints, 50);
    assert.equal(generic.extensions?.transferFee?.maxFee, "100");

    // stablecoin → guarded template: freeze enables the pausable extension.
    const stablecoin = resolveSettingsToExtensions("stablecoin", "fiat_backed", {
      freezeTransfers: {},
    });
    assert.deepEqual(stablecoin.errors, []);
    assert.ok(stablecoin.extensions?.pausable, "pausable should be enabled");
  });

  it("injects the provided authority and passes through decimals/allowlist", () => {
    const result = resolveSettingsToExtensions(
      "generic",
      "generic",
      { permanentDelegate: {} },
      {
        authorities: { permanentDelegate: "CustodyAddr1111111111111111111111111111111" },
        decimals: 2,
        requiresAllowlist: true,
      }
    );
    assert.deepEqual(result.errors, []);
    // the real authority is used — never a placeholder.
    assert.equal(
      result.extensions?.permanentDelegate,
      "CustodyAddr1111111111111111111111111111111"
    );
    assert.equal(result.decimals, 2);
    assert.equal(result.requiresAllowlist, true);
  });

  it("surfaces a template error for a selection the substrate can't build", () => {
    // Bypassing the capability check, a transferFee on the stablecoin template
    // (which doesn't offer it) is rejected by the resolver — the production
    // safety net behind the dev-time assertion.
    const result = resolveSettingsToExtensions("stablecoin", "fiat_backed", {
      transferFee: { params: { basisPoints: 10, maxFee: "1" } },
    });
    assert.ok(result.errors.length > 0, "expected a template override error");
    assert.equal(result.errors[0].code, "EXTENSION_NOT_ALLOWED");
  });

  it("returns an error for an unknown asset type", () => {
    const result = resolveSettingsToExtensions("generic", "not_a_type", { freezeTransfers: {} });
    assert.ok(result.errors.length > 0);
  });

  it("keeps the committed support matrix in sync with the registry", () => {
    const committed = readFileSync(
      fileURLToPath(new URL("./SUPPORT_MATRIX.md", import.meta.url)),
      "utf8"
    );
    assert.equal(
      renderSupportMatrixMarkdown(),
      committed,
      "SUPPORT_MATRIX.md is stale — run `pnpm --filter @sdp/issuance matrix:generate`"
    );
  });
});
