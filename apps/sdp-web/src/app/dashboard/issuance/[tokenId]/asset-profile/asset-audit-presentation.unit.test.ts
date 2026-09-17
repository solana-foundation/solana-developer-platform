import { describe, expect, it } from "vitest";
import { auditActionLabel } from "./asset-audit-presentation";

describe("auditActionLabel", () => {
  it("gives every create-shaped row in the QA lifecycle explicit context", () => {
    const t = (key: string) =>
      ({
        "DashboardIssuance.activity.createToken": "Create token",
        "DashboardIssuance.activity.createAssetProfile": "Create asset profile",
        "DashboardIssuance.activity.approveRecipient": "Approve recipient",
        "DashboardIssuance.activity.removeRecipient": "Remove recipient",
      })[key] ?? key;
    expect(
      [
        ["create", "token"],
        ["create", "asset_profile"],
        ["create", "token_allowlist"],
        ["revoke", "token_allowlist"],
      ].map(([action, resourceType]) => auditActionLabel(action, resourceType, t))
    ).toEqual(["Create token", "Create asset profile", "Approve recipient", "Remove recipient"]);
  });

  it("keeps the generic label for transaction actions", () => {
    expect(auditActionLabel("update_authority", "token_transaction")).toBe("Update authority");
  });
});
