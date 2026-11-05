// @vitest-environment jsdom

import type { Counterparty } from "@sdp/types/counterparties";
import type { CounterpartyAccountSummary } from "@sdp/types/payments";
import type { OrganizationRole } from "@sdp/types/roles";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { counterpartyReads } from "@/app/(session)/dashboard/[projectId]/payments/payments-query-key";
import { resolveDashboardAccess } from "@/lib/dashboard-access";
import { useInvalidateDashboardReads } from "@/lib/dashboard-swr";
import { stubDashboardFetch } from "@/test/dashboard-fetch";
import { DashboardReadsProvider } from "@/test/dashboard-reads";
import { filterDirectory } from "./counterparty-directory-filter";
import { CounterpartyWorkspace } from "./counterparty-workspace";

vi.mock("@/i18n/provider", () => ({
  useTranslations: () => (key: string) => key,
  useLocale: () => "en",
}));

vi.mock("next/navigation", () => import("@/test/next-navigation"));

const access = vi.hoisted((): { role: OrganizationRole } => ({ role: "member" }));
vi.mock("@/contexts/dashboard-workspace-context", async () => {
  const { resolveDashboardAccess: resolve } = await import("@/lib/dashboard-access");
  return {
    useOptionalDashboardWorkspace: () => ({ dashboardAccess: resolve(access.role) }),
    useCanWrite: () => resolve(access.role).capabilities.canWrite,
  };
});

vi.mock("next/link", () => ({
  default: ({ children, href }: { children: ReactNode; href: string }) => (
    <a href={href}>{children}</a>
  ),
}));

vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

// The real menu is a Radix dropdown; render its sections flat so a test can pick an option.
vi.mock("@sdp/ui/filter-menu", () => ({
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

const directory = { contacts: [withAddress, withoutAddress], addressesFail: false };

function serveDirectory() {
  return stubDashboardFetch(({ path }) => {
    if (path.startsWith("/api/dashboard/counterparty/accounts?")) {
      return directory.addressesFail
        ? Response.json({ error: { message: "unavailable" } }, { status: 503 })
        : Response.json({ data: { accounts: [savedAccount], total: 1, page: 1, pageSize: 100 } });
    }
    return Response.json({
      data: {
        counterparties: directory.contacts,
        total: directory.contacts.length,
        page: 1,
        pageSize: 100,
      },
    });
  });
}

function ReadContactsAgain() {
  const invalidateReads = useInvalidateDashboardReads();
  return (
    <button type="button" onClick={() => void invalidateReads(counterpartyReads)}>
      read contacts again
    </button>
  );
}

async function renderDirectory() {
  serveDirectory();
  const view = render(
    <DashboardReadsProvider>
      <CounterpartyWorkspace />
      <ReadContactsAgain />
    </DashboardReadsProvider>
  );
  await waitFor(() =>
    expect(document.querySelector('[data-loading-layout="counterparty-directory"]')).toBeNull()
  );
  return view.container;
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  access.role = "member";
  directory.contacts = [withAddress, withoutAddress];
  directory.addressesFail = false;
});

describe("CounterpartyWorkspace address filter", () => {
  it("stops applying a selected address filter once a refresh hides it", async () => {
    const container = await renderDirectory();
    const visibleNames = () =>
      [...container.querySelectorAll("[data-counterparty-directory-table] tbody tr")].map(
        (row) => row.textContent ?? ""
      );

    const hasAddress = container.querySelector<HTMLButtonElement>('[data-filter-option="with"]');
    if (hasAddress === null) throw new Error("Expected the address filter to be offered");
    act(() => hasAddress.click());
    expect(visibleNames()).toHaveLength(1);
    expect(visibleNames()[0]).toContain("Has Wallet");

    directory.addressesFail = true;
    act(() => screen.getByRole("button", { name: "read contacts again" }).click());

    await waitFor(() =>
      expect(container.querySelector('[data-filter-section="address"]')).toBeNull()
    );
    expect(container.textContent).not.toContain("DashboardPayments.counterparty.noMatches");
    const names = visibleNames();
    expect(names).toHaveLength(2);
    expect(names.some((name) => name.includes("No Wallet"))).toBe(true);
  });
});

describe("CounterpartyWorkspace for a read-only member", () => {
  async function renderEmptyDirectory(role: OrganizationRole) {
    access.role = role;
    directory.contacts = [];
    return renderDirectory();
  }

  it("offers a member the first contact from the empty directory", async () => {
    const container = await renderEmptyDirectory("member");
    expect(container.querySelector('a[href$="/payments/counterparty/create"]')).not.toBeNull();
  });

  it("offers a viewer no contact to add", async () => {
    expect(resolveDashboardAccess("viewer").capabilities.canWrite).toBe(false);
    const container = await renderEmptyDirectory("viewer");
    expect(container.textContent).toContain("DashboardPayments.counterparty.noContacts");
    expect(container.querySelector('a[href$="/payments/counterparty/create"]')).toBeNull();
    expect(container.textContent).not.toContain("DashboardPayments.counterparty.addContact");
  });
});
