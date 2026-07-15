import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { ASSET_TYPES } from "@sdp/types";

import {
  ADVANCED_SETTINGS,
  ASSET_CAPABILITIES,
  getRecommendedSettings,
  isSettingAllowed,
  listSettingsForType,
  resolveAssetCapability,
  SETTING_KEYS,
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

    // debt securities additionally recommend interest.
    assert.ok(getRecommendedSettings("tokenized_security", "debt").includes("interestBearing"));

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
});
