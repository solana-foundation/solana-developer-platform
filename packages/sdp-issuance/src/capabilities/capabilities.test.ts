import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import { ASSET_TYPES } from "@sdp/types";

import {
  ADVANCED_SETTINGS,
  ADVANCED_SETTINGS_VERSION,
  ASSET_CAPABILITIES,
  getConflictingSettingKeys,
  getLockedSettings,
  getRecommendedSettings,
  isSettingAllowed,
  listSettingsForType,
  pruneIncompatibleSettings,
  renderSupportMatrixMarkdown,
  resolveAssetCapability,
  resolveSettingsToExtensions,
  SETTING_KEYS,
  validateSelectedSettings,
  validateSettingParams,
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

  it("locks the extensions the guarded template forces on", () => {
    // Stablecoin forces permanentDelegate + pausable, so both covering settings
    // are locked (on and non-deselectable), not merely recommended.
    const stablecoin = resolveAssetCapability("stablecoin", "fiat_backed");
    assert.equal(stablecoin?.settings.permanentDelegate, "locked");
    assert.equal(stablecoin?.settings.freezeTransfers, "locked");
    assert.deepEqual(getLockedSettings("stablecoin", "fiat_backed").sort(), [
      "freezeTransfers",
      "permanentDelegate",
    ]);

    // Locked settings are still "allowed" and still pre-selected (default on).
    assert.equal(isSettingAllowed("stablecoin", "fiat_backed", "permanentDelegate"), true);
    assert.ok(getRecommendedSettings("stablecoin", "fiat_backed").includes("permanentDelegate"));

    // scaledUiAmount is conditional in the security builder, so it stays
    // recommended (deselectable), not locked.
    const security = resolveAssetCapability("tokenized_security", "equity");
    assert.equal(security?.settings.scaledUiAmount, "recommended");
    assert.equal(security?.settings.permanentDelegate, "locked");

    // generic assets deploy as custom (nothing forced) — no locked settings.
    assert.deepEqual(getLockedSettings("generic", "generic"), []);
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

  it("range-checks numeric expert params against the catalog bounds", () => {
    // basisPoints catalog range is [0, 10_000]. In-range passes.
    assert.deepEqual(
      validateSettingParams({ transferFee: { params: { basisPoints: 250, maxFee: "0" } } }),
      []
    );
    // Below the min and above the max are each rejected, with the violated bound echoed.
    assert.deepEqual(validateSettingParams({ transferFee: { params: { basisPoints: -1 } } }), [
      { settingKey: "transferFee", paramKey: "basisPoints", reason: "below_min", limit: 0 },
    ]);
    assert.deepEqual(validateSettingParams({ transferFee: { params: { basisPoints: 99999 } } }), [
      { settingKey: "transferFee", paramKey: "basisPoints", reason: "above_max", limit: 10_000 },
    ]);
  });

  it("rejects out-of-range values sent as numeric strings, not just numbers", () => {
    // The selection schema permits string OR number; a crafted "99999" must not
    // slip past the bound the same way the number 99999 doesn't.
    assert.deepEqual(validateSettingParams({ transferFee: { params: { basisPoints: "99999" } } }), [
      { settingKey: "transferFee", paramKey: "basisPoints", reason: "above_max", limit: 10_000 },
    ]);
    // A non-numeric string for a number param is rejected rather than silently
    // coerced to the resolver's fallback.
    assert.deepEqual(validateSettingParams({ transferFee: { params: { basisPoints: "abc" } } }), [
      { settingKey: "transferFee", paramKey: "basisPoints", reason: "not_a_number" },
    ]);
  });

  it("ignores absent params and params of unknown settings", () => {
    // basisPoints is required in the editor, but presence is enforced elsewhere —
    // bounds only apply to supplied values, so an empty params map is clean here.
    assert.deepEqual(validateSettingParams({ transferFee: { params: {} } }), []);
    assert.deepEqual(validateSettingParams({ transferFee: {} }), []);
    // An unknown setting key is the key-level check's concern; its params are skipped.
    assert.deepEqual(validateSettingParams({ made_up: { params: { basisPoints: 99999 } } }), []);
  });

  it("requires scaledUiAmount.multiplier to be strictly positive (exclusive min 0)", () => {
    // Any value above 0 is valid, including fractional scale-downs.
    assert.deepEqual(validateSettingParams({ scaledUiAmount: { params: { multiplier: 2 } } }), []);
    assert.deepEqual(
      validateSettingParams({ scaledUiAmount: { params: { multiplier: 0.5 } } }),
      []
    );
    // Exactly 0 is rejected (it would zero every displayed balance), as are negatives.
    assert.deepEqual(validateSettingParams({ scaledUiAmount: { params: { multiplier: 0 } } }), [
      { settingKey: "scaledUiAmount", paramKey: "multiplier", reason: "below_min", limit: 0 },
    ]);
    assert.deepEqual(validateSettingParams({ scaledUiAmount: { params: { multiplier: -1 } } }), [
      { settingKey: "scaledUiAmount", paramKey: "multiplier", reason: "below_min", limit: 0 },
    ]);
  });

  it("rejects non-finite values on a max-unbounded param (multiplier: Infinity)", () => {
    // multiplier has no max, so a non-finite value would pass a bare min check and
    // deploy a token that permanently displays every balance as ∞. Both the number
    // Infinity and its string forms must be rejected as not_a_number.
    for (const bad of [
      Number.POSITIVE_INFINITY,
      Number.NEGATIVE_INFINITY,
      Number.NaN,
      "Infinity",
      "-Infinity",
      "1e999",
    ] as const) {
      assert.deepEqual(
        validateSettingParams({ scaledUiAmount: { params: { multiplier: bad } } }),
        [{ settingKey: "scaledUiAmount", paramKey: "multiplier", reason: "not_a_number" }],
        `expected multiplier ${String(bad)} to be rejected`
      );
    }
    // A finite string multiplier still passes.
    assert.deepEqual(
      validateSettingParams({ scaledUiAmount: { params: { multiplier: "2" } } }),
      []
    );
  });

  it("bounds interestBearing.rate to the on-chain i16 basis-points range", () => {
    // Negative rates are valid (demurrage), so the full signed-16-bit span passes.
    assert.deepEqual(validateSettingParams({ interestBearing: { params: { rate: -32_768 } } }), []);
    assert.deepEqual(validateSettingParams({ interestBearing: { params: { rate: 32_767 } } }), []);
    assert.deepEqual(validateSettingParams({ interestBearing: { params: { rate: 500 } } }), []);
    // Values that would overflow the i16 are rejected before deploy.
    assert.deepEqual(validateSettingParams({ interestBearing: { params: { rate: 32_768 } } }), [
      { settingKey: "interestBearing", paramKey: "rate", reason: "above_max", limit: 32_767 },
    ]);
    assert.deepEqual(validateSettingParams({ interestBearing: { params: { rate: -32_769 } } }), [
      { settingKey: "interestBearing", paramKey: "rate", reason: "below_min", limit: -32_768 },
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

  it("falls back to a safe default when a direct caller bypasses the validator with a non-finite param", () => {
    // resolveSettingsToExtensions is exported and callable without validateSettingParams,
    // so its toNumber must not pass a non-finite value into an immutable extension. A
    // multiplier of Infinity (number or "Infinity" string) resolves to the default 1.
    for (const bad of [Number.POSITIVE_INFINITY, "Infinity", "1e999"] as const) {
      const result = resolveSettingsToExtensions("generic", "generic", {
        scaledUiAmount: { params: { multiplier: bad } },
      });
      assert.deepEqual(result.errors, []);
      assert.equal(
        result.extensions?.scaledUiAmount?.multiplier,
        1,
        `multiplier ${String(bad)} should fall back to 1`
      );
    }
    // A finite value still flows through unchanged.
    const ok = resolveSettingsToExtensions("generic", "generic", {
      scaledUiAmount: { params: { multiplier: 2 } },
    });
    assert.equal(ok.extensions?.scaledUiAmount?.multiplier, 2);
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

  it("rejects two extensions that cannot coexist on one mint", () => {
    // interestBearing + scaledUiAmount both define the raw→UI amount conversion,
    // so they conflict even though each is individually valid on a generic asset.
    assert.deepEqual(getConflictingSettingKeys("interestBearing"), ["scaledUiAmount"]);
    assert.deepEqual(getConflictingSettingKeys("scaledUiAmount"), ["interestBearing"]);
    // nonTransferable can't pair with a fee or a hook (no transfers to act on).
    assert.deepEqual(getConflictingSettingKeys("nonTransferable").sort(), [
      "transferFee",
      "transferHook",
    ]);
    // A setting with no conflicts returns an empty list.
    assert.deepEqual(getConflictingSettingKeys("freezeTransfers"), []);

    const result = resolveSettingsToExtensions("generic", "generic", {
      interestBearing: { params: { rate: 5 } },
      scaledUiAmount: { params: { multiplier: 2 } },
    });
    assert.ok(
      result.errors.some((e) => e.code === "EXTENSION_NOT_ALLOWED"),
      "expected a conflict error for interestBearing + scaledUiAmount"
    );

    // Either one alone resolves cleanly.
    const single = resolveSettingsToExtensions("generic", "generic", {
      interestBearing: { params: { rate: 5 } },
    });
    assert.deepEqual(single.errors, []);
  });

  it("prunes a conflicting pair to a valid subset (keeping the earlier one)", () => {
    // Simulates re-validating a stale persisted selection with both conflicting
    // extensions checked: the earlier-listed one is kept, the later dropped.
    assert.deepEqual(pruneIncompatibleSettings(["interestBearing", "scaledUiAmount"]), [
      "interestBearing",
    ]);
    assert.deepEqual(pruneIncompatibleSettings(["scaledUiAmount", "interestBearing"]), [
      "scaledUiAmount",
    ]);
    // Non-conflicting keys pass through; unknown keys are dropped.
    assert.deepEqual(pruneIncompatibleSettings(["freezeTransfers", "made_up", "transferFee"]), [
      "freezeTransfers",
      "transferFee",
    ]);
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
