import { describe, expect, it } from "vitest";
import { getMessages, type MessageKey, translate } from "@/i18n/messages";
import { createInitialCapacities } from "./issuance-draft-wizard.types";
import {
  applyCombo,
  comboItemLabelKeys,
  getComboConflict,
  getCombosForCategory,
  getDefaultCombo,
  isComboActive,
  removeCombo,
  SETTING_COMBOS,
  type SettingCombo,
} from "./setting-combos";

const messages = getMessages("en");

function comboByKey(key: string): SettingCombo {
  const combo = SETTING_COMBOS.find((entry) => entry.key === key);
  if (!combo) {
    throw new Error(`no combo "${key}"`);
  }
  return combo;
}

describe("getDefaultCombo", () => {
  it("maps regulated categories to their flagship preset", () => {
    expect(getDefaultCombo("stablecoin")?.key).toBe("regulatedStablecoin");
    expect(getDefaultCombo("tokenized_security")?.key).toBe("regulatedSecurity");
  });

  it("leaves generic without a default so it starts blank", () => {
    expect(getDefaultCombo("generic")).toBeUndefined();
  });
});

describe("getCombosForCategory", () => {
  it("returns only the combos scoped to that category", () => {
    const generic = getCombosForCategory("generic");
    expect(generic.length).toBeGreaterThan(0);
    expect(generic.every((combo) => combo.category === "generic")).toBe(true);
  });
});

describe("applyCombo / isComboActive", () => {
  it("enables a combo's settings, capacities, and access-control mode and reads back active", () => {
    const combo = comboByKey("controlledAsset"); // freezeTransfers + permanentDelegate; kyc; allowlist
    const { settings, capacities, accessControl } = applyCombo(
      combo,
      {},
      createInitialCapacities()
    );
    expect(settings.freezeTransfers).toBeDefined();
    expect(settings.permanentDelegate).toBeDefined();
    expect(capacities.kyc.enabled).toBe(true);
    expect(accessControl).toBe("allowlist");
    expect(isComboActive(combo, settings, capacities, accessControl)).toBe(true);
  });

  it("seeds default params but leaves required-without-default fields blank", () => {
    const combo = comboByKey("revenueShare"); // transferFee: maxFee has a default, basisPoints required
    const { settings } = applyCombo(combo, {}, createInitialCapacities());
    expect(settings.transferFee?.params?.maxFee).toBe("0");
    expect(settings.transferFee?.params?.basisPoints).toBeUndefined();
  });

  it("is not active until every bundled item — including the access mode — is on", () => {
    const combo = comboByKey("gatedAccess"); // freezeTransfers; kyc, restrictTradingHours; allowlist
    const { settings, capacities, accessControl } = applyCombo(
      combo,
      {},
      createInitialCapacities()
    );
    expect(isComboActive(combo, settings, capacities, accessControl)).toBe(true);
    // Drop one bundled capacity → the combo no longer reads as active.
    expect(
      isComboActive(
        combo,
        settings,
        { ...capacities, restrictTradingHours: { enabled: false } },
        accessControl
      )
    ).toBe(false);
    // Drop the access mode → also no longer active.
    expect(isComboActive(combo, settings, capacities, "")).toBe(false);
  });

  it("preset toggling only flips the enable bit — per-policy config is preserved", () => {
    const combo = comboByKey("gatedAccess"); // bundles restrictTradingHours
    const seeded = createInitialCapacities();
    seeded.restrictTradingHours = { enabled: false, config: { schedule: "market_hours" } };

    // Applying the preset enables the policy but keeps the config the user set.
    const applied = applyCombo(combo, {}, seeded);
    expect(applied.capacities.restrictTradingHours).toEqual({
      enabled: true,
      config: { schedule: "market_hours" },
    });

    // Removing it clears only enabled; config survives so re-selecting restores it.
    const next = removeCombo(
      combo,
      applied.settings,
      applied.capacities,
      [],
      applied.accessControl
    );
    expect(next.capacities.restrictTradingHours).toEqual({
      enabled: false,
      config: { schedule: "market_hours" },
    });
  });
});

describe("removeCombo", () => {
  it("preserves items still needed by another active combo", () => {
    const controlled = comboByKey("controlledAsset"); // freezeTransfers, permanentDelegate; kyc; allowlist
    const gated = comboByKey("gatedAccess"); // freezeTransfers; kyc, restrictTradingHours; allowlist

    // Enable both — they share freezeTransfers, kyc, and the allowlist mode.
    let state = applyCombo(controlled, {}, createInitialCapacities());
    state = applyCombo(gated, state.settings, state.capacities, state.accessControl);
    expect(isComboActive(controlled, state.settings, state.capacities, state.accessControl)).toBe(
      true
    );
    expect(isComboActive(gated, state.settings, state.capacities, state.accessControl)).toBe(true);

    // Deselecting gated must not strip what controlled still relies on. Neither is a
    // superset of the other, so nothing cascades.
    const next = removeCombo(
      gated,
      state.settings,
      state.capacities,
      [controlled],
      state.accessControl
    );
    expect(next.settings.freezeTransfers).toBeDefined(); // kept — controlled needs it
    expect(next.capacities.kyc.enabled).toBe(true); // kept — controlled needs it
    expect(next.accessControl).toBe("allowlist"); // kept — controlled needs it
    expect(next.capacities.restrictTradingHours.enabled).toBe(false); // gated-only — dropped
    expect(next.settings.permanentDelegate).toBeDefined(); // controlled untouched
    expect(isComboActive(controlled, next.settings, next.capacities, next.accessControl)).toBe(
      true
    );
    expect(isComboActive(gated, next.settings, next.capacities, next.accessControl)).toBe(false);
  });
});

describe("getComboConflict", () => {
  it("names the enabled setting and reason for the non-transferable ↔ fee pair", () => {
    // nonTransferable is on (e.g. from Loyalty & rewards); a transfer-fee combo clashes.
    const conflict = getComboConflict(comboByKey("revenueShare"), { nonTransferable: {} });
    expect(conflict).toEqual({
      withLabelKey: "DashboardIssuance.config.nonTransferable",
      reasonKey: "DashboardIssuance.config.comboConflictReasonNonTransferableFee",
    });
    // Both keys must resolve to real copy.
    expect(() => translate(messages, conflict?.withLabelKey as MessageKey)).not.toThrow();
    expect(() => translate(messages, conflict?.reasonKey as MessageKey)).not.toThrow();
  });

  it("detects the balance-display conflict (interestBearing ↔ scaledUiAmount)", () => {
    const conflict = getComboConflict(comboByKey("regulatedSecurity"), {
      interestBearing: {},
    });
    expect(conflict?.withLabelKey).toBe("DashboardIssuance.config.interestBearing");
    expect(conflict?.reasonKey).toBe("DashboardIssuance.config.comboConflictReasonBalanceDisplay");
  });

  it("returns null when the combo clashes with nothing enabled", () => {
    // gatedAccess bundles freezeTransfers, which is incompatible with no other extension.
    expect(getComboConflict(comboByKey("gatedAccess"), { nonTransferable: {} })).toBeNull();
  });
});

describe("combo deselect", () => {
  // Behavioral replacement for the old structural "unique defining item" invariant.
  // With cascade deselect, a preset that nests another (shares all its items) is
  // still cleanly removable, so the property we care about is simply: every combo
  // can be turned off once applied. An accidental empty/dead preset (the historical
  // "Plain digital asset" bug) would be un-removable and fail here.
  it("every combo can be turned off once applied", () => {
    for (const combo of SETTING_COMBOS) {
      const applied = applyCombo(combo, {}, createInitialCapacities());
      // The real editor passes every other active combo in the same category.
      const others = SETTING_COMBOS.filter(
        (c) =>
          c.category === combo.category &&
          c.key !== combo.key &&
          isComboActive(c, applied.settings, applied.capacities, applied.accessControl)
      );
      const next = removeCombo(
        combo,
        applied.settings,
        applied.capacities,
        others,
        applied.accessControl
      );
      expect(
        isComboActive(combo, next.settings, next.capacities, next.accessControl),
        `combo "${combo.key}" cannot be turned off`
      ).toBe(false);
    }
  });

  it("cascades scenarios built on the atomic verified-holders preset", () => {
    const verified = comboByKey("verifiedHolders"); // kyc; allowlist
    const gated = comboByKey("gatedAccess"); // ⊇ verifiedHolders (also freeze + trading hours)

    // Turning on gated access implies verified holders (shared kyc + allowlist).
    const applied = applyCombo(gated, {}, createInitialCapacities());
    expect(isComboActive(gated, applied.settings, applied.capacities, applied.accessControl)).toBe(
      true
    );
    expect(
      isComboActive(verified, applied.settings, applied.capacities, applied.accessControl)
    ).toBe(true);

    // Removing verified holders drops the allowlist requirement gated access depends
    // on, so gated access cascades off too and the mode resets to an explicit None.
    const next = removeCombo(
      verified,
      applied.settings,
      applied.capacities,
      [gated],
      applied.accessControl
    );
    expect(isComboActive(verified, next.settings, next.capacities, next.accessControl)).toBe(false);
    expect(isComboActive(gated, next.settings, next.capacities, next.accessControl)).toBe(false);
    // Deselecting the gating preset lands on an explicit None, not the blank prompt.
    expect(next.accessControl).toBe("disabled");
  });

  it("keeps the shared verified-holders base when a scenario on top is removed", () => {
    const verified = comboByKey("verifiedHolders");
    const gated = comboByKey("gatedAccess");

    const applied = applyCombo(gated, {}, createInitialCapacities());
    // Removing gated (not a superset-removal of verified) leaves the shared kyc +
    // allowlist, so verified holders stays active; only gated-only items drop.
    const next = removeCombo(
      gated,
      applied.settings,
      applied.capacities,
      [verified],
      applied.accessControl
    );
    expect(isComboActive(gated, next.settings, next.capacities, next.accessControl)).toBe(false);
    expect(isComboActive(verified, next.settings, next.capacities, next.accessControl)).toBe(true);
    expect(next.accessControl).toBe("allowlist");
  });
});

describe("tokenized-security presets combine instead of contradicting", () => {
  // The two security presets are complementary layers on the same allowlist — a
  // regulated-security base plus an additive fund-lifecycle layer — so both can be
  // active at once (a fund) without the "public XOR private" contradiction.
  it("regulatedSecurity + fundOperations stack, sharing the allowlist", () => {
    const base = comboByKey("regulatedSecurity");
    const fund = comboByKey("fundOperations");

    let state = applyCombo(base, {}, createInitialCapacities());
    state = applyCombo(fund, state.settings, state.capacities, state.accessControl);

    // Neither deactivates the other; the union is the full fund stack.
    expect(isComboActive(base, state.settings, state.capacities, state.accessControl)).toBe(true);
    expect(isComboActive(fund, state.settings, state.capacities, state.accessControl)).toBe(true);
    expect(state.capacities.restrictTradingHours.enabled).toBe(true); // base
    expect(state.capacities.redemptionApprovals.enabled).toBe(true); // fund layer
    expect(state.accessControl).toBe("allowlist"); // shared, no contradiction
  });

  it("removing the fund layer keeps the regulated-security base intact", () => {
    const base = comboByKey("regulatedSecurity");
    const fund = comboByKey("fundOperations");

    let state = applyCombo(base, {}, createInitialCapacities());
    state = applyCombo(fund, state.settings, state.capacities, state.accessControl);

    // Neither is a superset of the other, so dropping the fund layer leaves the base.
    const next = removeCombo(fund, state.settings, state.capacities, [base], state.accessControl);
    expect(isComboActive(base, next.settings, next.capacities, next.accessControl)).toBe(true);
    expect(isComboActive(fund, next.settings, next.capacities, next.accessControl)).toBe(false);
    expect(next.capacities.redemptionApprovals.enabled).toBe(false); // fund-only, dropped
    expect(next.capacities.transferApprovals.enabled).toBe(true); // base, kept
    expect(next.accessControl).toBe("allowlist"); // base still needs it
  });
});

describe("combo i18n", () => {
  it("every combo label, description, and bundled item resolves", () => {
    for (const combo of SETTING_COMBOS) {
      expect(() => translate(messages, combo.labelKey as MessageKey)).not.toThrow();
      expect(() => translate(messages, combo.descriptionKey as MessageKey)).not.toThrow();
      for (const key of comboItemLabelKeys(combo)) {
        expect(() => translate(messages, key as MessageKey)).not.toThrow();
      }
    }
  });
});
