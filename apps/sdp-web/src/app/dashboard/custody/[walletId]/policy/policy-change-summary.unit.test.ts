import type { PolicyRule } from "@sdp/types";
import { describe, expect, it } from "vitest";
import {
  groupPolicyChanges,
  type PolicyFieldLabels,
  summarizePolicyChanges,
} from "./policy-change-summary";
import type { WalletPolicyWritePayload } from "./wallet-policy-authoring";

const LABELS: PolicyFieldLabels = {
  defaultAction: "Default decision",
  operationControls: "Operation controls",
  operationLabel: (operation) => operation.toUpperCase(),
  actionLabel: (action) => action.replaceAll("_", " "),
  defaultActionLabel: (action) => action.toUpperCase(),
};

function payload(overrides: Partial<WalletPolicyWritePayload>): WalletPolicyWritePayload {
  return {
    walletId: "wallet-1",
    defaultAction: "allow",
    rules: [],
    ...overrides,
  };
}

describe("summarizePolicyChanges", () => {
  it("returns no rows for identical payloads", () => {
    const value = payload({ defaultAction: "allow" });
    expect(summarizePolicyChanges(value, value, LABELS)).toEqual([]);
  });

  it("emits removed and added rows for a changed scalar field", () => {
    const rows = summarizePolicyChanges(
      payload({ defaultAction: "allow" }),
      payload({ defaultAction: "deny" }),
      LABELS
    );
    expect(rows).toEqual([
      { direction: "removed", group: "defaultAction", label: "Default decision", value: "ALLOW" },
      { direction: "added", group: "defaultAction", label: "Default decision", value: "DENY" },
    ]);
  });

  it("summarizes item changes within a rule matched by id", () => {
    const before = payload({
      rules: [
        {
          id: "allowed-assets",
          kind: "asset",
          assets: [
            "MintAaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            "MintBbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
          ],
          action: "allow",
          name: "Allowed assets",
        },
      ],
    });
    const after = payload({
      rules: [
        {
          id: "allowed-assets",
          kind: "asset",
          assets: ["MintAaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"],
          action: "allow",
          name: "Allowed assets",
        },
      ],
    });
    const rows = summarizePolicyChanges(before, after, LABELS);
    expect(rows).toEqual([
      {
        direction: "removed",
        group: "rule:asset:allowed-assets",
        label: "Allowed assets",
        value: "MintBb…bbbb",
      },
    ]);
  });

  it("emits a result row when a rule's items empty out", () => {
    const before = payload({
      rules: [
        {
          id: "allowed-assets",
          kind: "asset",
          assets: ["MintAaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"],
          action: "allow",
          name: "Allowed assets",
        },
      ],
    });
    const after = payload({
      rules: [
        {
          id: "allowed-assets",
          kind: "asset",
          assets: [],
          action: "allow",
          name: "Allowed assets",
        },
      ],
    });
    const rows = summarizePolicyChanges(before, after, LABELS);
    expect(rows.map((row) => row.direction)).toEqual(["removed", "result"]);
    expect(rows[1]).toEqual({
      direction: "result",
      group: "rule:asset:allowed-assets",
      label: "Allowed assets",
      value: "",
    });
  });

  it("emits removed plus result rows for a fully removed rule", () => {
    const rule: PolicyRule = {
      id: "per-transaction-limit",
      kind: "amount",
      max: "100",
      assets: ["MintAaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"],
      action: "allow",
      name: "Per transaction limit",
    };
    const rows = summarizePolicyChanges(payload({ rules: [rule] }), payload({}), LABELS);
    expect(rows).toEqual([
      {
        direction: "removed",
        group: "rule:amount:per-transaction-limit",
        label: "Per transaction limit",
        value: "MintAa…aaaa, allow, max 100",
      },
      {
        direction: "result",
        group: "rule:amount:per-transaction-limit",
        label: "Per transaction limit",
        value: "",
      },
    ]);
  });

  it("emits scalar rows when a rule's amount bound changes", () => {
    const before = payload({
      rules: [
        {
          id: "per-transaction-limit",
          kind: "amount",
          max: "100",
          assets: ["MintAaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"],
          action: "allow",
        },
      ],
    });
    const after = payload({
      rules: [
        {
          id: "per-transaction-limit",
          kind: "amount",
          max: "50",
          assets: ["MintAaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"],
          action: "allow",
        },
      ],
    });
    const rows = summarizePolicyChanges(before, after, LABELS);
    expect(rows).toEqual([
      {
        direction: "removed",
        group: "rule:amount:per-transaction-limit",
        label: "per-transaction-limit",
        value: "allow, max 100",
      },
      {
        direction: "added",
        group: "rule:amount:per-transaction-limit",
        label: "per-transaction-limit",
        value: "allow, max 50",
      },
    ]);
  });

  it("summarizes operation reassignments as action transitions under one label", () => {
    const before = payload({
      rules: [
        {
          id: "operation-families-approval_required",
          kind: "operation_family",
          families: ["ramp"],
          action: "approval_required",
          name: "Operation families: approval required",
        },
      ],
    });
    const after = payload({
      rules: [
        {
          id: "operation-families-allow",
          kind: "operation_family",
          families: ["ramp"],
          action: "allow",
          name: "Operation families: allow",
        },
        {
          id: "operation-families-deny",
          kind: "operation_family",
          families: ["transfer", "raw_sign"],
          action: "deny",
          name: "Operation families: deny",
        },
      ],
    });
    const rows = summarizePolicyChanges(before, after, LABELS);
    expect(rows).toEqual([
      {
        direction: "removed",
        group: "operations",
        label: "Operation controls",
        value: "RAMP · approval required",
      },
      {
        direction: "added",
        group: "operations",
        label: "Operation controls",
        value: "RAMP · allow",
      },
      {
        direction: "added",
        group: "operations",
        label: "Operation controls",
        value: "TRANSFER, RAW_SIGN · deny",
      },
    ]);
  });

  it("reports every action when conflicting rules assign the same operation", () => {
    const before = payload({
      rules: [
        {
          id: "passthrough-ramp",
          kind: "operation_family",
          family: "ramp",
          action: "approval_required",
        },
        {
          id: "operation-families-deny",
          kind: "operation_family",
          families: ["ramp"],
          action: "deny",
        },
      ],
    });
    const rows = summarizePolicyChanges(before, payload({}), LABELS);
    expect(rows).toEqual([
      {
        direction: "removed",
        group: "operations",
        label: "Operation controls",
        value: "RAMP · approval required",
      },
      {
        direction: "removed",
        group: "operations",
        label: "Operation controls",
        value: "RAMP · deny",
      },
    ]);
  });

  const FULL_POLICY = payload({
    defaultAction: "deny",
    rules: [
      {
        id: "allowed-assets",
        kind: "asset",
        assets: ["MintAaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"],
        action: "allow",
        name: "Allowed assets",
      },
      {
        id: "operation-families-deny",
        kind: "operation_family",
        families: ["transfer"],
        action: "deny",
        name: "Operation families: deny",
      },
    ],
  });

  it("emits added rows for everything a new policy declares", () => {
    const rows = summarizePolicyChanges(payload({}), FULL_POLICY, LABELS);
    expect(rows).toEqual([
      { direction: "removed", group: "defaultAction", label: "Default decision", value: "ALLOW" },
      { direction: "added", group: "defaultAction", label: "Default decision", value: "DENY" },
      {
        direction: "added",
        group: "operations",
        label: "Operation controls",
        value: "TRANSFER · deny",
      },
      {
        direction: "added",
        group: "rule:asset:allowed-assets",
        label: "Allowed assets",
        value: "MintAa…aaaa, allow",
      },
    ]);
  });

  it("emits removed rows plus empty results when everything is deleted", () => {
    const rows = summarizePolicyChanges(FULL_POLICY, payload({}), LABELS);
    expect(rows).toEqual([
      { direction: "removed", group: "defaultAction", label: "Default decision", value: "DENY" },
      { direction: "added", group: "defaultAction", label: "Default decision", value: "ALLOW" },
      {
        direction: "removed",
        group: "operations",
        label: "Operation controls",
        value: "TRANSFER · deny",
      },
      {
        direction: "removed",
        group: "rule:asset:allowed-assets",
        label: "Allowed assets",
        value: "MintAa…aaaa, allow",
      },
      {
        direction: "result",
        group: "rule:asset:allowed-assets",
        label: "Allowed assets",
        value: "",
      },
    ]);
  });

  it("summarizes deleting one rule while adding another in the same change", () => {
    const before = payload({
      rules: [
        {
          id: "allowlist-destinations",
          kind: "destination",
          allowlist: ["Dq73PQAySHjTwJaUQqSoxHwszGRiZxYYGmBkzJUM2KCh"],
          action: "allow",
          name: "Allowed destinations",
        },
      ],
    });
    const after = payload({
      rules: [
        {
          id: "allowed-assets",
          kind: "asset",
          assets: ["MintAaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"],
          action: "allow",
          name: "Allowed assets",
        },
      ],
    });
    const rows = summarizePolicyChanges(before, after, LABELS);
    expect(rows).toEqual([
      {
        direction: "removed",
        group: "rule:destination:allowlist-destinations",
        label: "Allowed destinations",
        value: "Dq73PQ…2KCh, allow",
      },
      {
        direction: "result",
        group: "rule:destination:allowlist-destinations",
        label: "Allowed destinations",
        value: "",
      },
      {
        direction: "added",
        group: "rule:asset:allowed-assets",
        label: "Allowed assets",
        value: "MintAa…aaaa, allow",
      },
    ]);
  });

  it("emits nothing when rules only reorder", () => {
    const ruleA: PolicyRule = { id: "a", kind: "always", action: "deny", name: "A" };
    const ruleB: PolicyRule = { id: "b", kind: "always", action: "allow", name: "B" };
    const rows = summarizePolicyChanges(
      payload({ rules: [ruleA, ruleB] }),
      payload({ rules: [ruleB, ruleA] }),
      LABELS
    );
    expect(rows).toEqual([]);
  });
});

describe("summarizePolicyChanges field coverage", () => {
  it("reports a per-transaction change once, via its amount rule", () => {
    const before = payload({
      rules: [
        {
          id: "per-transaction-limit",
          kind: "amount",
          max: "100",
          assets: ["MintAaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"],
          action: "allow",
          name: "Per transaction limit",
        },
      ],
    });
    const after = payload({
      rules: [
        {
          id: "per-transaction-limit",
          kind: "amount",
          max: "150",
          assets: ["MintAaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"],
          action: "allow",
          name: "Per transaction limit",
        },
      ],
    });
    const rows = summarizePolicyChanges(before, after, LABELS);
    expect(rows).toEqual([
      {
        direction: "removed",
        group: "rule:amount:per-transaction-limit",
        label: "Per transaction limit",
        value: "allow, max 100",
      },
      {
        direction: "added",
        group: "rule:amount:per-transaction-limit",
        label: "Per transaction limit",
        value: "allow, max 150",
      },
    ]);
  });

  it("reports operation type changes as transitions", () => {
    const before = payload({
      rules: [
        {
          id: "operation-types-deny",
          kind: "operation_type",
          operationTypes: ["custom:op"],
          action: "deny",
        },
      ],
    });
    const rows = summarizePolicyChanges(before, payload({}), LABELS);
    expect(rows).toEqual([
      {
        direction: "removed",
        group: "operations",
        label: "Operation controls",
        value: "CUSTOM:OP · deny",
      },
    ]);
  });

  it("reports approval rule group changes as scalar transitions", () => {
    const before = payload({
      rules: [
        { id: "approval-rule", kind: "approval", approvalGroupId: "grp_1", name: "Approvals" },
      ],
    });
    const after = payload({
      rules: [
        { id: "approval-rule", kind: "approval", approvalGroupId: "grp_2", name: "Approvals" },
      ],
    });
    const rows = summarizePolicyChanges(before, after, LABELS);
    expect(rows).toEqual([
      {
        direction: "removed",
        group: "rule:approval:approval-rule",
        label: "Approvals",
        value: "grp_1",
      },
      {
        direction: "added",
        group: "rule:approval:approval-rule",
        label: "Approvals",
        value: "grp_2",
      },
    ]);
  });

  it("reports an always rule action change as scalar transitions", () => {
    const before = payload({
      rules: [{ id: "always-rule", kind: "always", action: "deny", name: "Always" }],
    });
    const after = payload({
      rules: [{ id: "always-rule", kind: "always", action: "allow", name: "Always" }],
    });
    const rows = summarizePolicyChanges(before, after, LABELS);
    expect(rows).toEqual([
      { direction: "removed", group: "rule:always:always-rule", label: "Always", value: "deny" },
      { direction: "added", group: "rule:always:always-rule", label: "Always", value: "allow" },
    ]);
  });

  it("reports a rule kind change as a removal plus an addition, never an item diff", () => {
    const before = payload({
      rules: [
        {
          id: "sneaky",
          kind: "asset",
          assets: ["MintAaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"],
          action: "allow",
          name: "Allowed assets",
        },
      ],
    });
    const after = payload({
      rules: [{ id: "sneaky", kind: "always", action: "allow", name: "Allowed assets" }],
    });
    const rows = summarizePolicyChanges(before, after, LABELS);
    expect(rows).toEqual([
      {
        direction: "removed",
        group: "rule:asset:sneaky",
        label: "Allowed assets",
        value: "MintAa…aaaa, allow",
      },
      { direction: "result", group: "rule:asset:sneaky", label: "Allowed assets", value: "" },
      { direction: "added", group: "rule:always:sneaky", label: "Allowed assets", value: "allow" },
    ]);
  });

  it("reports destination rule membership changes", () => {
    const before = payload({
      rules: [
        {
          id: "allowlist-destinations",
          kind: "destination",
          allowlist: [
            "3mppZAgZgF3EgXu2Jexvhzx7FDcSRUnqoVps6J9vwKCE",
            "Dq73PQAySHjTwJaUQqSoxHwszGRiZxYYGmBkzJUM2KCh",
          ],
          action: "allow",
          name: "Allowed destinations",
        },
      ],
    });
    const after = payload({
      rules: [
        {
          id: "allowlist-destinations",
          kind: "destination",
          allowlist: ["3mppZAgZgF3EgXu2Jexvhzx7FDcSRUnqoVps6J9vwKCE"],
          action: "allow",
          name: "Allowed destinations",
        },
      ],
    });
    const rows = summarizePolicyChanges(before, after, LABELS);
    expect(rows).toEqual([
      {
        direction: "removed",
        group: "rule:destination:allowlist-destinations",
        label: "Allowed destinations",
        value: "Dq73PQ…2KCh",
      },
    ]);
  });
});

describe("groupPolicyChanges", () => {
  it("groups rows by their stable key in first-appearance order", () => {
    const rows = summarizePolicyChanges(
      payload({ defaultAction: "allow" }),
      payload({
        defaultAction: "deny",
        rules: [
          {
            id: "allowlist-destinations",
            kind: "destination",
            allowlist: ["3mppZAgZgF3EgXu2Jexvhzx7FDcSRUnqoVps6J9vwKCE"],
            action: "allow",
            name: "Allowed destinations",
          },
        ],
      }),
      LABELS
    );
    const groups = groupPolicyChanges(rows);
    expect(groups.map((group) => group.label)).toEqual([
      "Default decision",
      "Allowed destinations",
    ]);
    expect(groups[0].rows).toHaveLength(2);
    expect(groups[1].rows).toHaveLength(1);
  });

  it("keeps rules sharing a display name in their own groups", () => {
    const rows = summarizePolicyChanges(
      payload({
        rules: [
          {
            id: "allowlist-destinations",
            kind: "destination",
            allowlist: ["3mppZAgZgF3EgXu2Jexvhzx7FDcSRUnqoVps6J9vwKCE"],
            action: "allow",
            name: "Allow list",
          },
          { id: "custom-rule", kind: "always", action: "deny", name: "Allow list" },
        ],
      }),
      payload({}),
      LABELS
    );
    const groups = groupPolicyChanges(rows);
    expect(groups.map((group) => group.label)).toEqual(["Allow list", "Allow list"]);
    expect(groups.map((group) => group.rows[0].group)).toEqual([
      "rule:destination:allowlist-destinations",
      "rule:always:custom-rule",
    ]);
  });
});
