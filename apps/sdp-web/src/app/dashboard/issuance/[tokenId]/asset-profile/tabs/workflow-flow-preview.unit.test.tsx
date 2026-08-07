import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { CatalogActionView, CatalogTriggerView } from "../workflows.data";
import { WorkflowFlowGraph } from "./workflow-flow-preview";

vi.mock("@/i18n/provider", () => ({
  useTranslations: () => (key: string, values?: Record<string, string | number>) =>
    values ? `${key}(${Object.values(values).join(",")})` : key,
}));

const trigger: CatalogTriggerView = {
  type: "onramp_settled",
  trigger: { labelKey: "t", descriptionKey: "t", conditionFields: ["provider"] },
};

function action(
  requires: CatalogActionView["action"]["requires"],
  tier: CatalogActionView["action"]["execution"],
  support: CatalogActionView["support"] = { ok: true }
): CatalogActionView {
  return {
    type: "mint",
    action: { labelKey: "mint", descriptionKey: "mint", execution: tier, requires },
    support,
  };
}

function render(props: Partial<Parameters<typeof WorkflowFlowGraph>[0]>) {
  return renderToStaticMarkup(
    <WorkflowFlowGraph
      trigger={trigger}
      action={null}
      guards={[]}
      reviewMode="auto"
      paramSummary=""
      walletGap={false}
      {...props}
    />
  );
}

describe("WorkflowFlowGraph", () => {
  it("names the authority a base-requirement action uses (not 'no capability required')", () => {
    const markup = render({
      action: action({ kind: "base", action: "mint" }, "requires_approval"),
    });
    expect(markup).toContain("flowCapabilityBase");
    expect(markup).not.toContain("flowCapabilityNone");
  });

  it("shows a blocked wallet-gap step when the trigger can't identify a wallet", () => {
    const markup = render({
      action: action({ kind: "base", action: "mint" }, "requires_approval"),
      walletGap: true,
    });
    expect(markup).toContain("flowWalletGap");
    // The action leg is blocked too — the rule would enqueue and permanently fail.
    // Blocked status shows as a red trailing glyph (text-error), not a tinted chip.
    expect(markup).toContain("text-error");
  });

  it("marks an unsupported capability as blocked with its reason", () => {
    const markup = render({
      action: action({ kind: "allowlist" }, "automated", { ok: false, reason: "no_allowlist" }),
    });
    expect(markup).toContain("flowReasonNoAllowlist");
    expect(markup).toContain("text-error");
  });

  it("always holds destructive tiers for review, with the hold-to-confirm note", () => {
    const markup = render({
      action: action({ kind: "base", action: "mint" }, "requires_approval"),
    });
    expect(markup).toContain("flowHeldForReview");
    expect(markup).toContain("flowHoldNote");
    expect(markup).not.toContain("flowAutoApplies");
  });

  it("auto-applies non-destructive tiers under auto review", () => {
    const markup = render({ action: action({ kind: "none" }, "automated") });
    expect(markup).toContain("flowAutoApplies");
  });

  it("renders comma-separated `in` guard values as a tidy list", () => {
    const markup = render({
      guards: [{ id: "g1", field: "provider", op: "in", value: " mural,, bridge " }],
    });
    expect(markup).toContain("mural, bridge");
  });
});
