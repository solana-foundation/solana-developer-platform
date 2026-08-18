import { describe, expect, it } from "vitest";
import { compliancePolicyChanged } from "./handlers";

describe("compliancePolicyChanged", () => {
  it("returns false for identical metadata", () => {
    const metadata = {
      asset: { name: "Acme" },
      settings: { version: 3, selected: { permanentDelegate: {} } },
      compliance: { accessControl: "allowlist", capacities: { tradingHours: { enabled: true } } },
    };
    expect(compliancePolicyChanged(metadata, structuredClone(metadata))).toBe(false);
  });

  it("ignores the server-stamped settings.version", () => {
    const before = { settings: { version: 2, selected: { transferHook: {} } } };
    const after = { settings: { version: 9, selected: { transferHook: {} } } };
    expect(compliancePolicyChanged(before, after)).toBe(false);
  });

  it("ignores object key ordering", () => {
    const before = { settings: { selected: { a: { params: { x: "1" } }, b: {} } } };
    const after = { settings: { selected: { b: {}, a: { params: { x: "1" } } } } };
    expect(compliancePolicyChanged(before, after)).toBe(false);
  });

  it("treats the legacy and current capacity encodings as equal", () => {
    const legacy = { compliance: { capacities: { investorReporting: true } } };
    const current = { compliance: { capacities: { investorReporting: { enabled: true } } } };
    expect(compliancePolicyChanged(legacy, current)).toBe(false);
  });

  it("treats a disabled capacity as absent", () => {
    const before = { compliance: { capacities: {} } };
    const after = { compliance: { capacities: { tradingHours: { enabled: false } } } };
    expect(compliancePolicyChanged(before, after)).toBe(false);
  });

  it("detects an advanced-settings selection change", () => {
    const before = { settings: { selected: { permanentDelegate: {} } } };
    const after = { settings: { selected: { permanentDelegate: {}, transferHook: {} } } };
    expect(compliancePolicyChanged(before, after)).toBe(true);
  });

  it("detects a capacity being enabled", () => {
    const before = { compliance: { capacities: {} } };
    const after = { compliance: { capacities: { approvalRules: { enabled: true } } } };
    expect(compliancePolicyChanged(before, after)).toBe(true);
  });

  it("detects a capacity config change", () => {
    const before = { compliance: { capacities: { tradingHours: { enabled: true } } } };
    const after = {
      compliance: { capacities: { tradingHours: { enabled: true, config: { open: "09:00" } } } },
    };
    expect(compliancePolicyChanged(before, after)).toBe(true);
  });

  it("detects an access-control mode change", () => {
    const before = { compliance: { accessControl: "allowlist" } };
    const after = { compliance: { accessControl: "denylist" } };
    expect(compliancePolicyChanged(before, after)).toBe(true);
  });

  it("does not fire on non-policy fields (asset details, visibility, decimals)", () => {
    const before = {
      asset: { name: "Acme", description: "old" },
      chain: { decimals: 6 },
      visibility: { public: ["asset.name"] },
      settings: { version: 1, selected: { permanentDelegate: {} } },
      compliance: { accessControl: "allowlist" },
    };
    const after = {
      asset: { name: "Acme Corp", description: "new" },
      chain: { decimals: 9 },
      visibility: { public: ["asset.name", "asset.description"] },
      settings: { version: 1, selected: { permanentDelegate: {} } },
      compliance: { accessControl: "allowlist" },
    };
    expect(compliancePolicyChanged(before, after)).toBe(false);
  });

  it("handles undefined / empty metadata without reporting a change", () => {
    expect(compliancePolicyChanged(undefined, {})).toBe(false);
    expect(compliancePolicyChanged({}, { asset: { name: "Acme" } })).toBe(false);
  });
});
