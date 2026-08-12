import { describe, expect, it } from "vitest";
import type { CatalogActionView, GuardDraft } from "../workflows.data";
import { failureLabel, guardsToCondition, validateBuilder } from "./workflows-tab";

// Key-echo stand-in for the localized wf() helper.
const wf = (k: string, values?: Record<string, string | number>) =>
  values ? `${k}(${Object.values(values).join(",")})` : k;

function guard(partial: Partial<GuardDraft>): GuardDraft {
  return { id: "g1", field: "provider", op: "eq", value: "", ...partial };
}

function action(type: string, tier: CatalogActionView["action"]["execution"] = "automated") {
  return {
    type,
    action: {
      labelKey: type,
      descriptionKey: type,
      execution: tier,
      requires: { kind: "none" } as const,
    },
    support: { ok: true } as const,
  } satisfies CatalogActionView;
}

describe("guardsToCondition", () => {
  it("splits comma-separated `in` values, trimming empties", () => {
    const condition = guardsToCondition([guard({ op: "in", value: " mural, bridge ,, " })]);
    expect(condition).toEqual({
      all: [{ field: "provider", op: "in", value: ["mural", "bridge"] }],
    });
  });

  it("drops an `in` row that parses to nothing (commas only)", () => {
    expect(guardsToCondition([guard({ op: "in", value: " , ," })])).toBeUndefined();
  });

  it("returns undefined when no rows are filled (absent condition = always match)", () => {
    expect(guardsToCondition([])).toBeUndefined();
    expect(guardsToCondition([guard({ value: "  " })])).toBeUndefined();
  });

  it("keeps eq/neq values as trimmed strings", () => {
    expect(guardsToCondition([guard({ op: "neq", value: " mural " })])).toEqual({
      all: [{ field: "provider", op: "neq", value: "mural" }],
    });
  });
});

describe("validateBuilder", () => {
  it("rejects non-positive or non-numeric amounts", () => {
    for (const bad of ["-5", "abc", "0", "1.2.3", ""]) {
      const result = validateBuilder({
        triggerType: "kyc_approved",
        action: action("burn"),
        params: { amount: bad },
        guards: [],
        wf,
      });
      expect(result.ok, `amount ${JSON.stringify(bad)}`).toBe(false);
    }
    expect(
      validateBuilder({
        triggerType: "kyc_approved",
        action: action("burn"),
        params: { amount: "10.5" },
        guards: [],
        wf,
      }).ok
    ).toBe(true);
  });

  it("rejects a webhook url that isn't http(s)", () => {
    const result = validateBuilder({
      triggerType: "kyc_approved",
      action: action("send_webhook"),
      params: { url: "ftp://example.com" },
      guards: [],
      wf,
    });
    expect(result.fieldErrors.url).toBeTruthy();
  });

  it("blocks submit while a guard row is incomplete (never silently dropped)", () => {
    const result = validateBuilder({
      triggerType: "kyc_approved",
      action: action("record"),
      params: {},
      guards: [guard({ value: "" })],
      wf,
    });
    expect(result.guardsIncomplete).toBe(true);
    expect(result.ok).toBe(false);
  });

  it("flags the wallet gap when a wallet-less trigger drives a wallet-targeting action", () => {
    const gap = validateBuilder({
      triggerType: "onramp_settled",
      action: action("freeze"),
      params: {},
      guards: [],
      wf,
    });
    expect(gap.walletGap).toBe(true);

    // A wallet param fills the gap…
    const filled = validateBuilder({
      triggerType: "onramp_settled",
      action: action("freeze"),
      params: { wallet: "So11111111111111111111111111111111111111112" },
      guards: [],
      wf,
    });
    expect(filled.walletGap).toBe(false);

    // …and KYC triggers carry the wallet in the payload.
    const kyc = validateBuilder({
      triggerType: "kyc_approved",
      action: action("freeze"),
      params: {},
      guards: [],
      wf,
    });
    expect(kyc.walletGap).toBe(false);
  });
});

describe("failureLabel", () => {
  it("maps engine codes to localized keys, keeping the detail suffix", () => {
    expect(failureLabel("CAPABILITY_REVOKED:capability_disabled", wf)).toBe(
      "errorCodes.capabilityRevoked (capability_disabled)"
    );
    expect(failureLabel("RULE_DISABLED", wf)).toBe("errorCodes.ruleDisabled");
  });

  it("renders HTTP codes with the status interpolated", () => {
    expect(failureLabel("HTTP_502", wf)).toBe("errorCodes.http(502)");
  });

  it("falls back to the raw string for unknown errors (chain messages)", () => {
    expect(failureLabel("custom program error: 0x1771", wf)).toBe("custom program error: 0x1771");
  });
});
