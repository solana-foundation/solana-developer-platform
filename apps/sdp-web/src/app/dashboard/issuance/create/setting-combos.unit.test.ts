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
    expect(getDefaultCombo("tokenized_security")?.key).toBe("publicSecurityOffering");
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
  it("enables a combo's settings and capacities and reads back as active", () => {
    const combo = comboByKey("controlledAsset"); // freezeTransfers + permanentDelegate; kyc
    const { settings, capacities } = applyCombo(combo, {}, createInitialCapacities());
    expect(settings.freezeTransfers).toBeDefined();
    expect(settings.permanentDelegate).toBeDefined();
    expect(capacities.kyc).toBe(true);
    expect(isComboActive(combo, settings, capacities)).toBe(true);
  });

  it("seeds default params but leaves required-without-default fields blank", () => {
    const combo = comboByKey("revenueShare"); // transferFee: maxFee has a default, basisPoints required
    const { settings } = applyCombo(combo, {}, createInitialCapacities());
    expect(settings.transferFee?.params?.maxFee).toBe("0");
    expect(settings.transferFee?.params?.basisPoints).toBeUndefined();
  });

  it("is not active until every bundled item is on", () => {
    const combo = comboByKey("gatedAccess"); // freezeTransfers; kyc, restrictTradingHours
    const { settings, capacities } = applyCombo(combo, {}, createInitialCapacities());
    expect(isComboActive(combo, settings, capacities)).toBe(true);
    // Drop one bundled capacity → the combo no longer reads as active.
    expect(isComboActive(combo, settings, { ...capacities, restrictTradingHours: false })).toBe(
      false
    );
  });
});

describe("removeCombo", () => {
  it("preserves items still needed by another active combo", () => {
    const controlled = comboByKey("controlledAsset"); // freezeTransfers, permanentDelegate; kyc
    const gated = comboByKey("gatedAccess"); // freezeTransfers; kyc, restrictTradingHours

    // Enable both — they share freezeTransfers (setting) and kyc (capacity).
    let state = applyCombo(controlled, {}, createInitialCapacities());
    state = applyCombo(gated, state.settings, state.capacities);
    expect(isComboActive(controlled, state.settings, state.capacities)).toBe(true);
    expect(isComboActive(gated, state.settings, state.capacities)).toBe(true);

    // Deselecting gated must not strip what controlled still relies on.
    const next = removeCombo(gated, state.settings, state.capacities, [controlled]);
    expect(next.settings.freezeTransfers).toBeDefined(); // kept — controlled needs it
    expect(next.capacities.kyc).toBe(true); // kept — controlled needs it
    expect(next.capacities.restrictTradingHours).toBe(false); // gated-only — dropped
    expect(next.settings.permanentDelegate).toBeDefined(); // controlled untouched
    expect(isComboActive(controlled, next.settings, next.capacities)).toBe(true);
    expect(isComboActive(gated, next.settings, next.capacities)).toBe(false);
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
    const conflict = getComboConflict(comboByKey("publicSecurityOffering"), {
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

describe("combo deselect invariant", () => {
  // The derived-active model can only individually deselect a combo when it owns
  // at least one item no sibling combo in the same category uses (otherwise a
  // pure subset can never be turned off — the historical "Plain digital asset" bug).
  it("every combo has a unique defining item within its category", () => {
    for (const combo of SETTING_COMBOS) {
      const siblingItems = new Set<string>(
        SETTING_COMBOS.filter(
          (other) => other.category === combo.category && other.key !== combo.key
        ).flatMap((other) => [...other.settings, ...other.capacities])
      );
      const hasUnique = [...combo.settings, ...combo.capacities].some(
        (item) => !siblingItems.has(item)
      );
      expect(hasUnique, `combo "${combo.key}" has no unique defining item`).toBe(true);
    }
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
