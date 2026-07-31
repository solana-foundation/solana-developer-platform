import type { PolicyControlInventoryItem, PolicyControlInventoryResponse } from "@sdp/types";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { getMessages } from "@/i18n/messages";
import { I18nProvider } from "@/i18n/provider";
import {
  buildPoliciesHref,
  PoliciesOverviewSurface,
  type PoliciesUrlState,
} from "./policies-overview";

const state: PoliciesUrlState = {
  tab: "all",
  query: "",
  status: "",
  page: 1,
  pageSize: 25,
};

function wallet(
  targetId: string,
  status: PolicyControlInventoryItem["status"]
): PolicyControlInventoryItem {
  return {
    targetType: "wallet",
    targetId,
    walletId: targetId,
    walletAddress: `Address-${targetId}-111111111111111111`,
    displayName: `${status} wallet`,
    controlProfileId: status === "default_allow" ? null : `profile-${targetId}`,
    status,
    activeRevisionId: status === "active" ? `revision-${targetId}` : null,
    activeRevisionNumber: status === "active" ? 2 : null,
    defaultAction: status === "default_allow" ? "allow" : "deny",
    ruleCount: status === "default_allow" ? 0 : 2,
    updatedAt: "2026-07-16T12:00:00.000Z",
    activatedAt: status === "active" ? "2026-07-16T12:00:00.000Z" : null,
    latestEvaluation: null,
    providerMappingStatus: "not_applicable",
  };
}

function apiKey(
  targetId: string,
  bindingScope: "all" | "selected",
  selectedWalletCount: number
): PolicyControlInventoryItem {
  return {
    targetType: "api_key",
    targetId,
    apiKeyPrefix: `sk_test_${targetId}`,
    displayName: `${bindingScope} key`,
    controlProfileId: `profile-${targetId}`,
    status: "active",
    activeRevisionId: `revision-${targetId}`,
    activeRevisionNumber: 1,
    defaultAction: "approval_required",
    ruleCount: 1,
    updatedAt: "2026-07-16T12:00:00.000Z",
    activatedAt: "2026-07-16T12:00:00.000Z",
    latestEvaluation: null,
    bindingScope,
    selectedWalletCount,
  };
}

function inventory(controls: PolicyControlInventoryItem[]): PolicyControlInventoryResponse {
  return {
    controls,
    total: controls.length,
    page: 1,
    pageSize: 25,
    summary: {
      total: controls.length,
      defaultAllow: controls.filter((item) => item.status === "default_allow").length,
      draft: controls.filter((item) => item.status === "draft").length,
      active: controls.filter((item) => item.status === "active").length,
      disabled: controls.filter((item) => item.status === "disabled").length,
      totalApiKeyBindings: 4,
    },
  };
}

function renderSurface(props: Partial<Parameters<typeof PoliciesOverviewSurface>[0]> = {}): string {
  return renderToStaticMarkup(
    <I18nProvider locale="en" messages={getMessages("en")}>
      <PoliciesOverviewSurface
        inventory={inventory([])}
        error={false}
        state={state}
        searchValue=""
        {...props}
      />
    </I18nProvider>
  );
}

describe("PoliciesOverviewSurface", () => {
  it("renders every status and both API-key binding scopes from inventory data", () => {
    const markup = renderSurface({
      inventory: inventory([
        wallet("default", "default_allow"),
        wallet("draft", "draft"),
        wallet("active", "active"),
        wallet("disabled", "disabled"),
        apiKey("all", "all", 0),
        apiKey("selected", "selected", 3),
      ]),
    });

    expect(markup).toContain("Default allow");
    expect(markup).toContain("Draft");
    expect(markup).toContain("Active");
    expect(markup).toContain("Disabled");
    expect(markup).toContain("All wallets");
    expect(markup).toContain("3 selected wallets");
    expect(markup).toContain("No restrictions");
  });

  it("renders the clear-search control in the input action slot", () => {
    const markup = renderSurface({
      inventory: inventory([wallet("active", "active")]),
      searchValue: "treasury",
    });
    const clearButtonIndex = markup.indexOf('aria-label="Clear search"');
    const actionSlotIndex = markup.lastIndexOf(
      "relative z-10 inline-flex shrink-0 items-center justify-center",
      clearButtonIndex
    );

    expect(clearButtonIndex).toBeGreaterThan(-1);
    expect(actionSlotIndex).toBeGreaterThan(-1);
  });

  it("renders five table skeleton rows while loading", () => {
    const markup = renderSurface({ inventory: null, loading: true });
    expect(markup.match(/data-policy-skeleton-row/g)).toHaveLength(5);
  });

  it("renders error, empty-project, and filtered-empty states without fake counts", () => {
    const errorMarkup = renderSurface({ inventory: null, error: true });
    expect(errorMarkup).toContain("Could not load policy controls.");
    expect(errorMarkup).toContain("Retry");
    expect(errorMarkup).not.toContain("<dd");

    const emptyMarkup = renderSurface();
    expect(emptyMarkup).toContain("No wallet or API-key controls are configured.");
    expect(emptyMarkup).toContain("Configure controls");

    const filteredMarkup = renderSurface({
      state: { ...state, query: "missing" },
      searchValue: "missing",
    });
    expect(filteredMarkup).toContain("No controls match these filters.");
    expect(filteredMarkup).toContain("Clear filters");
  });

  it("keeps the wide table, mobile rows, and stacking breakpoint explicit", () => {
    const markup = renderSurface({ inventory: inventory([wallet("active", "active")]) });
    expect(markup).toMatch(/data-desktop-inventory="true"[^>]*hidden lg:block/);
    expect(markup).toMatch(/data-mobile-inventory="true"[^>]*lg:hidden/);
  });

  it("progressively hides lower-priority table columns on compact desktops", () => {
    const markup = renderSurface({ inventory: inventory([wallet("active", "active")]) });

    expect(markup).toContain("hidden xl:table-cell xl:w-[17%] 2xl:w-[12%]");
    expect(markup).toContain("hidden 2xl:table-cell 2xl:w-[15%]");
    expect(markup).not.toContain("min-w-[1160px]");
  });
});

describe("buildPoliciesHref", () => {
  it("stores tab, debounced search result, status, page, and page size in the URL", () => {
    expect(
      buildPoliciesHref(state, {
        tab: "api_keys",
        query: "treasury",
        status: "active",
        page: 3,
        pageSize: 50,
      })
    ).toBe("/dashboard/policies?tab=api_keys&page=3&pageSize=50&query=treasury&status=active");
  });
});
