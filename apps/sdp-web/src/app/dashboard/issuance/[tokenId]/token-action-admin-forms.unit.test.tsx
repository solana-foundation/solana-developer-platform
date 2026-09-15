// @vitest-environment jsdom

import type { PaymentsDashboardWallet, TokenAllowlistEntry } from "@sdp/types";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ComponentProps } from "react";
import { SWRConfig } from "swr";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DashboardWorkspaceProvider } from "@/contexts/dashboard-workspace-context";
import { getMessages } from "@/i18n/messages";
import { I18nProvider } from "@/i18n/provider";
import { resolveDashboardAccess } from "@/lib/dashboard-access";
import { TokenActionAdminForms } from "./token-action-admin-forms";
import {
  createInitialAuthorityForm,
  createInitialForceBurnForm,
  createInitialFreezeForm,
  createInitialSeizeForm,
} from "./token-management-workspace.utils";

const entry: TokenAllowlistEntry = {
  id: "tal_test",
  tokenId: "tok_test",
  address: "3yQfmv9WiotYSDmamiow5Xt2abcvDxTzmFBSYEEGZtqe",
  label: "Blocked address",
  status: "active",
  addedBy: "user_test",
  createdAt: "2026-09-15T00:00:00.000Z",
  revokedAt: null,
};

// Only framework/session and HTTP boundaries are mocked; SWR and fetchers stay real.
vi.mock("@clerk/nextjs", () => ({ useAuth: () => ({ isLoaded: false }) }));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn(), replace: vi.fn() }),
  usePathname: () => "/dashboard/issuance/tok_test",
  useSearchParams: () => new URLSearchParams(),
}));

const fetchMock = vi.fn<typeof fetch>();
const allowlistUrl = "/api/dashboard/issuance/tokens/tok_test/allowlist";

beforeEach(() => {
  localStorage.clear();
  fetchMock.mockReset();
  fetchMock.mockImplementation(async (input, init) => {
    if (init?.method !== "GET") throw new Error(`Unexpected method: ${init?.method}`);
    switch (input) {
      case `${allowlistUrl}/labels`:
        return Response.json({ labels: ["Blocked address"], total: 26 });
      case `${allowlistUrl}?page=1&pageSize=25`:
        return Response.json({ data: [entry], total: 26, page: 1, pageSize: 25, hasMore: true });
      case `${allowlistUrl}?page=2&pageSize=25`:
        return Response.json({
          data: [{ ...entry, id: "tal_page2", label: "Second page" }],
          total: 26,
          page: 2,
          pageSize: 25,
          hasMore: false,
        });
      case `${allowlistUrl}?page=1&pageSize=25&search=recipient`:
        return Response.json({
          data: [{ ...entry, label: "Search result" }],
          total: 1,
          page: 1,
          pageSize: 25,
          hasMore: false,
        });
      default:
        throw new Error(`Unexpected request: ${String(input)}`);
    }
  });
  vi.stubGlobal("fetch", fetchMock);
});

async function renderControlList(
  enableControlListSearch: boolean,
  signerUnavailableReason: string | null,
  overrides: Partial<ComponentProps<typeof TokenActionAdminForms>> = {}
) {
  const props: ComponentProps<typeof TokenActionAdminForms> = {
    activeAction: "allowlist",
    isPending: false,
    seizeForm: createInitialSeizeForm(),
    setSeizeForm: vi.fn(),
    forceBurnForm: createInitialForceBurnForm(),
    setForceBurnForm: vi.fn(),
    authorityForm: createInitialAuthorityForm(),
    setAuthorityForm: vi.fn(),
    freezeForm: createInitialFreezeForm(),
    setFreezeForm: vi.fn(),
    allowlistForm: { address: entry.address, label: "Recipient" },
    setAllowlistForm: vi.fn(),
    tokenId: entry.tokenId,
    enableControlListSearch,
    allowlistEntries: [entry],
    allowlistError: null,
    controlListLabel: "Blocked recipients",
    controlListDescription: null,
    controlListAddActionLabel: "Block recipient",
    controlListEmptyState: "No blocked recipients",
    freezeHint: null,
    signerWallets: [],
    walletOptions: [],
    signerUnavailableReason,
    seizeValidationErrors: { source: null, destination: null, amount: null },
    seizeValidationReason: null,
    forceBurnValidationErrors: { source: null, amount: null },
    forceBurnValidationReason: null,
    tokenStatus: "active",
    onSignerWalletIdChange: vi.fn(),
    onSeize: vi.fn(),
    onForceBurn: vi.fn(),
    onAuthorityUpdate: vi.fn(),
    onPause: vi.fn(),
    onFreeze: vi.fn(),
    onAddAllowlist: vi.fn(),
    onRemoveAllowlist: vi.fn(),
    ...overrides,
  };
  const view = render(
    <I18nProvider locale="en" messages={getMessages("en")}>
      <DashboardWorkspaceProvider
        dashboardAccess={resolveDashboardAccess("org:admin")}
        flags={{
          assetProfiles: true,
          custody: true,
          dvp: false,
          earn: false,
          heliusRings: false,
          issuance: true,
          markets: false,
          payments: false,
          policies: false,
          privateChannels: false,
        }}
        serverDashboardCacheScope={{ orgId: "org_test", userId: "user_test" }}
        projects={[]}
        initialSelectedProjectId="prj_test"
        shouldRepairInitialProjectCookie={false}
      >
        <SWRConfig value={{ shouldRetryOnError: false, dedupingInterval: 0 }}>
          <TokenActionAdminForms {...props} />
        </SWRConfig>
      </DashboardWorkspaceProvider>
    </I18nProvider>
  );
  await screen.findByText("Blocked address");
  return { ...view, props };
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe.each([false, true])("control-list signing availability (search=%s)", (searchable) => {
  it("blocks add/remove and form submission while keeping the list readable", async () => {
    const reason = "Signing is disabled for this wallet.";
    const { container, props } = await renderControlList(searchable, reason);
    const add = screen.getByRole<HTMLButtonElement>("button", { name: "Block recipient" });
    const remove = screen.getByRole<HTMLButtonElement>("button", { name: /remove/i });
    expect(add.disabled).toBe(true);
    expect(remove.disabled).toBe(true);
    expect(screen.getByText(reason)).toBeTruthy();
    expect(screen.getByText(entry.address)).toBeTruthy();
    fireEvent.click(add);
    fireEvent.click(remove);
    const form = container.querySelector("form");
    if (!form) throw new Error("Control-list form not rendered");
    fireEvent.submit(form);
    expect(props.onAddAllowlist).not.toHaveBeenCalled();
    expect(props.onRemoveAllowlist).not.toHaveBeenCalled();
    if (searchable) {
      const search = screen.getByPlaceholderText<HTMLInputElement>(/Search Blocked recipients/);
      expect(search.disabled).toBe(false);
      expect(screen.getByRole("combobox").textContent).toContain("All labels");
      expect(fetchMock).toHaveBeenCalledWith(
        `${allowlistUrl}/labels`,
        expect.objectContaining({ method: "GET" })
      );
      fireEvent.click(screen.getByRole("button", { name: /next page/i }));
      await screen.findByText("Second page");
      expect(fetchMock).toHaveBeenCalledWith(
        `${allowlistUrl}?page=2&pageSize=25`,
        expect.objectContaining({ method: "GET" })
      );
      fireEvent.change(search, { target: { value: "recipient" } });
      await screen.findByText("Search result");
      expect(fetchMock).toHaveBeenCalledWith(
        `${allowlistUrl}?page=1&pageSize=25&search=recipient`,
        expect.objectContaining({ method: "GET" })
      );
      await waitFor(() =>
        expect(screen.getByRole<HTMLButtonElement>("button", { name: /next page/i }).disabled).toBe(
          true
        )
      );
    }
  });

  it("shows the list signer and reads its runtime restriction as a warning", async () => {
    const signer: PaymentsDashboardWallet = {
      id: "cw_authority",
      walletId: "wal_authority",
      publicKey: "AuthorityPubKey",
      label: "List authority",
      isRuntimeExecutionAllowed: false,
    };
    const reason = "Signing is disabled for this wallet.";
    await renderControlList(searchable, reason, {
      signerWallets: [signer],
      defaultSignerWalletId: signer.id,
    });
    expect(
      screen.getByRole<HTMLButtonElement>("button", { name: "Block recipient" }).disabled
    ).toBe(true);
    // The list authority shows as an identity row with its wallet link, not a dead select.
    expect(screen.getByText(/List authority/)).toBeTruthy();
    expect(screen.getByRole("link", { name: /List authority/ }).getAttribute("href")).toBe(
      "/dashboard/wallets/wal_authority"
    );
    expect(screen.queryAllByRole("combobox").map((el) => el.textContent)).not.toContainEqual(
      expect.stringContaining("List authority")
    );
    expect(screen.getByText(reason).className).toContain("text-warning");
  });

  it("keeps mutation actions usable when no signer restriction applies", async () => {
    const { props } = await renderControlList(searchable, null);
    const add = screen.getByRole<HTMLButtonElement>("button", { name: "Block recipient" });
    const remove = screen.getByRole<HTMLButtonElement>("button", { name: /remove/i });
    expect(add.disabled).toBe(false);
    expect(remove.disabled).toBe(false);
    fireEvent.click(add);
    fireEvent.click(remove);
    expect(props.onAddAllowlist).toHaveBeenCalledOnce();
    expect(props.onRemoveAllowlist).toHaveBeenCalledWith(entry.id);
  });

  it("leaves multiple signers to the action confirmation instead of showing a dead picker", async () => {
    const { props } = await renderControlList(searchable, null, {
      signerWallets: [
        {
          id: "cw_config",
          walletId: "wal_config",
          publicKey: "AuthorityPubKey",
          label: "Config authority",
          isRuntimeExecutionAllowed: true,
        },
        {
          id: "cw_connection",
          walletId: "wal_connection",
          publicKey: "AuthorityPubKey",
          label: "Connection authority",
          isRuntimeExecutionAllowed: true,
        },
      ],
      defaultSignerWalletId: "",
    });
    expect(screen.queryAllByRole("combobox")).toHaveLength(searchable ? 1 : 0);
    fireEvent.click(screen.getByRole("button", { name: "Block recipient" }));
    expect(props.onAddAllowlist).toHaveBeenCalledOnce();
    expect(props.onSignerWalletIdChange).not.toHaveBeenCalled();
  });
});
