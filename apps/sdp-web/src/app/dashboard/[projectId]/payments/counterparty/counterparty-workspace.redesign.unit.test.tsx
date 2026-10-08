import type { Counterparty, CounterpartyAccountSummary } from "@sdp/types";
import { act, type ReactNode } from "react";
import type { Root } from "react-dom/client";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { builtinEnvironments, type EnvironmentReturn } from "vitest/environments";
import { filterDirectory } from "./counterparty-directory-filter.redesign";
import { CounterpartyWorkspace } from "./counterparty-workspace.redesign";

vi.mock("@/i18n/provider", () => ({
  useTranslations: () => (key: string) => key,
  useLocale: () => "en",
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
}));

vi.mock("next/link", () => ({
  default: ({ children, href }: { children: ReactNode; href: string }) => (
    <a href={href}>{children}</a>
  ),
}));

vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

// The real menu is a Radix dropdown; render its sections flat so a test can pick an option.
vi.mock("@/components/ui/filter-menu", () => ({
  FilterMenu: ({ sections }: { sections: { id: string; content: ReactNode }[] }) => (
    <div>
      {sections.map((section) => (
        <div key={section.id} data-filter-section={section.id}>
          {section.content}
        </div>
      ))}
    </div>
  ),
  FilterMenuOptions: ({
    options,
    onChange,
  }: {
    options: { value: string; label: string }[];
    onChange: (value: string | undefined) => void;
  }) => (
    <>
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          data-filter-option={option.value}
          onClick={() => onChange(option.value)}
        >
          {option.label}
        </button>
      ))}
    </>
  ),
}));

function contact(id: string, displayName: string): Counterparty {
  return {
    id,
    organizationId: "org_test",
    projectId: "prj_test",
    externalId: null,
    entityType: "individual",
    displayName,
    status: "active",
    createdBy: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}

const withAddress = contact("cpty_with", "Has Wallet");
const withoutAddress = contact("cpty_without", "No Wallet");
const savedAccount: CounterpartyAccountSummary = {
  counterpartyId: withAddress.id,
  counterpartyAccountId: "cpa_1",
  name: "Main wallet",
  address: "So11111111111111111111111111111111111111112",
  label: null,
};

describe("filterDirectory", () => {
  const addresses = new Map([[withAddress.id, [savedAccount.address]]]);

  it("narrows by the address filter only when one is passed", () => {
    const all = [withAddress, withoutAddress];
    expect(filterDirectory(all, addresses, { query: "", addressFilter: "with" })).toEqual([
      withAddress,
    ]);
    expect(filterDirectory(all, addresses, { query: "", addressFilter: "without" })).toEqual([
      withoutAddress,
    ]);
    expect(filterDirectory(all, addresses, { query: "" })).toEqual(all);
  });

  it("searches saved addresses alongside the name", () => {
    expect(filterDirectory([withAddress, withoutAddress], addresses, { query: "so1111" })).toEqual([
      withAddress,
    ]);
  });
});

describe("CounterpartyWorkspace address filter", () => {
  let environment: EnvironmentReturn;
  let root: Root;
  let container: HTMLDivElement;

  beforeAll(async () => {
    environment = await builtinEnvironments.jsdom.setup(globalThis, {
      jsdom: { url: "http://localhost" },
    });
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  });
  afterEach(async () => {
    if (root !== undefined) await act(async () => root.unmount());
    container?.remove();
  });
  afterAll(async () => {
    vi.unstubAllGlobals();
    await environment.teardown(globalThis);
  });

  function workspace(accountsFailed: boolean) {
    return (
      <CounterpartyWorkspace
        counterparties={[withAddress, withoutAddress]}
        total={2}
        accounts={accountsFailed ? [] : [savedAccount]}
        accountsFailed={accountsFailed}
      />
    );
  }

  function visibleNames() {
    return [...container.querySelectorAll("[data-counterparty-directory-table] tbody tr")].map(
      (row) => row.textContent ?? ""
    );
  }

  it("stops applying a selected address filter once a refresh hides it", async () => {
    container = document.createElement("div");
    document.body.append(container);
    const { createRoot } = await import("react-dom/client");
    root = createRoot(container);
    await act(async () => root.render(workspace(false)));

    const hasAddress = container.querySelector<HTMLButtonElement>('[data-filter-option="with"]');
    if (hasAddress === null) throw new Error("Expected the address filter to be offered");
    await act(async () => hasAddress.click());
    expect(visibleNames()).toHaveLength(1);
    expect(visibleNames()[0]).toContain("Has Wallet");

    // A refresh whose saved-address read fails: the same mounted list, new props.
    await act(async () => root.render(workspace(true)));

    expect(container.querySelector('[data-filter-section="address"]')).toBeNull();
    expect(container.textContent).not.toContain("DashboardPayments.counterparty.noMatches");
    const names = visibleNames();
    expect(names).toHaveLength(2);
    expect(names.some((name) => name.includes("No Wallet"))).toBe(true);
  });
});
