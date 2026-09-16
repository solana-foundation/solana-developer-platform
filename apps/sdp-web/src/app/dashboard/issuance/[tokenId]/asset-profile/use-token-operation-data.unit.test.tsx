// @vitest-environment jsdom

import type { AssetProfile, PaymentsDashboardWallet, Token } from "@sdp/types";
import { cleanup, render, renderHook, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { SWRConfig } from "swr";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { DashboardWorkspaceProvider } from "@/contexts/dashboard-workspace-context";
import { getMessages } from "@/i18n/messages";
import { I18nProvider } from "@/i18n/provider";
import { resolveDashboardAccess } from "@/lib/dashboard-access";
import { AssetManagementWorkspace } from "./asset-management-workspace";
import { useTokenOperationData } from "./use-token-operation-data";

// Framework/session boundaries only: the data hooks, SWR and fetchers stay real.
vi.mock("@clerk/nextjs", () => ({ useAuth: () => ({ isLoaded: false }) }));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn(), replace: vi.fn() }),
  usePathname: () => "/dashboard/issuance/tok_test",
  useSearchParams: () => new URLSearchParams(),
}));
const saveProfile = vi.hoisted(() => vi.fn());
// Server Action is the browser/server mutation boundary.
vi.mock("./actions", () => ({ updateAssetProfileAction: saveProfile }));

const wallet: PaymentsDashboardWallet = {
  id: "cwlt_a",
  walletId: "provider_a",
  isRuntimeExecutionAllowed: true,
  publicKey: "address_a",
  label: "Wallet A",
};
function authorityData(wallets: PaymentsDashboardWallet[]) {
  return {
    authorityWallets: wallets,
    authorityWalletsError: null,
    allowlistAuthority: null,
    allowlistAuthorityError: null,
    metadataAuthority: null,
    metadataAuthorityError: null,
  };
}
const token: Token = {
  id: "tok_test",
  organizationId: "org_test",
  projectId: "prj_test",
  signingCustodyWalletId: wallet.id,
  signingWalletId: wallet.walletId,
  name: "Draft token",
  symbol: "DRAFT",
  decimals: 6,
  description: "Original description",
  template: "custom",
  status: "pending",
  mintAddress: null,
  mintAuthority: null,
  metadataAuthority: null,
  freezeAuthority: null,
  ablListAddress: null,
  uri: null,
  imageUrl: null,
  extensions: null,
  totalSupply: "0",
  maxSupply: null,
  isMintable: true,
  isFreezable: false,
  requiresAllowlist: false,
  deployedAt: null,
  createdBy: "user_test",
  createdAt: "2026-09-09T00:00:00Z",
  updatedAt: "2026-09-09T00:00:00Z",
};
const profile: AssetProfile = {
  id: "asp_test",
  tokenId: token.id,
  organizationId: token.organizationId,
  projectId: token.projectId,
  assetCategory: "generic",
  assetType: "generic",
  assetTypeVersion: 1,
  issuanceMetadata: {
    custom: {
      customer: {
        authorityWalletIds: { "mint-authority": wallet.id, "metadata-authority": wallet.id },
      },
    },
  },
  publicMetadata: {},
  status: "active",
  createdBy: "user_test",
  createdAt: token.createdAt,
  updatedAt: token.updatedAt,
};

function wrapper({ children }: { children: ReactNode }) {
  return (
    <I18nProvider locale="en" messages={getMessages("en")}>
      <DashboardWorkspaceProvider
        scopeRefreshFallback={<div>Loading workspace</div>}
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
        <SWRConfig value={{ shouldRetryOnError: false, dedupingInterval: 0 }}>{children}</SWRConfig>
      </DashboardWorkspaceProvider>
    </I18nProvider>
  );
}

function renderData(input: Token = token) {
  return renderHook(
    () =>
      useTokenOperationData({
        token: input,
        shouldLoadAuthorityWallets: true,
      }),
    { wrapper }
  );
}

beforeEach(() => {
  localStorage.clear();
  vi.spyOn(window, "scrollTo").mockImplementation(() => {});
  saveProfile.mockReset();
  saveProfile.mockResolvedValue({ state: "success", message: "Saved", assetProfile: null });
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

it("loads authority wallets", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn<typeof fetch>(async () => Response.json({ data: authorityData([wallet]) }))
  );
  const { result } = renderData();
  await waitFor(() => expect(result.current.authorityWallets).toEqual([wallet]));
  expect(result.current.authorityWallets).toEqual([wallet]);
  expect(result.current.authorityWalletsError).toBeNull();
});

it("loads frozen-account totals for a deployed token after freeze authority is revoked", async () => {
  const deployedToken = {
    ...token,
    status: "active" as const,
    mintAddress: "58NU6ZxKq3aVv2q1s9bJcYtvHkbEwLmPqRs4TuVwVjVu",
    isFreezable: false,
    freezeAuthority: null,
  };
  vi.stubGlobal(
    "fetch",
    vi.fn<typeof fetch>(async (input) =>
      String(input).endsWith("/frozen")
        ? Response.json({ data: [], error: null, total: 3 })
        : Response.json({ data: authorityData([wallet]) })
    )
  );

  const { result } = renderData(deployedToken);

  await waitFor(() => expect(result.current.frozenAccountsTotal).toBe(3));
  expect(result.current.frozenAccountsError).toBeNull();
});

it.each([true, false])(
  "settings show save controls immediately and Discard exits editing (changed: %s)",
  async (changed) => {
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>(async () => Response.json({ data: authorityData([wallet]) }))
    );
    const user = userEvent.setup();
    render(<AssetManagementWorkspace token={token} assetProfile={profile} tokenError={null} />, {
      wrapper,
    });
    await user.click(screen.getByRole("button", { name: "Settings" }));
    expect(screen.queryByRole("button", { name: "Discard" })).toBeNull();
    await user.click(screen.getByRole("button", { name: "Edit settings" }));
    expect(screen.getByRole("button", { name: "Save changes" }).hasAttribute("disabled")).toBe(
      true
    );
    expect(screen.queryByRole("button", { name: "Done" })).toBeNull();
    if (changed) {
      await user.type(screen.getByLabelText("Description"), " changed");
      await waitFor(() =>
        expect(screen.getByRole("button", { name: "Save changes" }).hasAttribute("disabled")).toBe(
          false
        )
      );
    }
    await user.click(screen.getByRole("button", { name: "Discard" }));
    expect(screen.getByRole("button", { name: "Edit settings" })).toBeTruthy();
    expect(screen.queryByLabelText("Description")).toBeNull();
    expect(screen.getByText("Original description")).toBeTruthy();
    await waitFor(() => expect(screen.queryByRole("button", { name: "Discard" })).toBeNull());
    expect(saveProfile).not.toHaveBeenCalled();
  }
);

it.each(["success", "error"] as const)(
  "settings only exit editing after a successful save (%s)",
  async (state) => {
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>(async () => Response.json({ data: authorityData([wallet]) }))
    );
    saveProfile.mockResolvedValue({ state, message: state, assetProfile: null });
    const user = userEvent.setup();
    render(<AssetManagementWorkspace token={token} assetProfile={profile} tokenError={null} />, {
      wrapper,
    });
    await user.click(screen.getByRole("button", { name: "Settings" }));
    await user.click(screen.getByRole("button", { name: "Edit settings" }));
    await user.type(screen.getByLabelText("Description"), " changed");
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Save changes" }).hasAttribute("disabled")).toBe(
        false
      )
    );
    await user.click(screen.getByRole("button", { name: "Save changes" }));
    await waitFor(() => expect(saveProfile).toHaveBeenCalledOnce());
    if (state === "success") {
      expect(screen.getByRole("button", { name: "Edit settings" })).toBeTruthy();
      expect(screen.queryByLabelText("Description")).toBeNull();
    } else {
      expect(screen.queryByRole("button", { name: "Edit settings" })).toBeNull();
      expect(screen.getByLabelText("Description")).toBeTruthy();
      expect(screen.getByRole("button", { name: "Discard" })).toBeTruthy();
    }
  }
);

it.each([true, false])(
  "pending draft Save and Deploy follow wallet availability (%s)",
  async (walletsAvailable) => {
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>(async (input) =>
        walletsAvailable && String(input).endsWith("/authority-wallets")
          ? Response.json({ data: authorityData([wallet]) })
          : Response.json({ error: { message: "Wallet service unavailable" } }, { status: 503 })
      )
    );
    const user = userEvent.setup();
    render(<AssetManagementWorkspace token={token} assetProfile={profile} tokenError={null} />, {
      wrapper,
    });
    if (walletsAvailable)
      await waitFor(() =>
        expect(screen.getByRole("button", { name: "Deploy" }).hasAttribute("disabled")).toBe(false)
      );
    await user.click(screen.getByRole("button", { name: "Settings" }));
    await user.click(screen.getByRole("button", { name: "Edit settings" }));
    const description = screen.getByLabelText("Description");
    await user.clear(description);
    await user.type(description, "Updated draft description");
    await user.click(screen.getByRole("button", { name: "Save changes" }));
    if (walletsAvailable) {
      await waitFor(() =>
        expect(saveProfile).toHaveBeenCalledWith(
          expect.objectContaining({
            tokenPatch: expect.objectContaining({
              signingCustodyWalletId: "cwlt_a",
              description: "Updated draft description",
            }),
          })
        )
      );
    } else {
      await waitFor(() =>
        expect(screen.getByRole("button", { name: "Save changes" }).hasAttribute("disabled")).toBe(
          true
        )
      );
      expect(screen.getByRole("button", { name: "Deploy" }).hasAttribute("disabled")).toBe(true);
      expect(saveProfile).not.toHaveBeenCalled();
    }
  }
);

it("preserves a wallet-level error inside a successful HTTP response", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn<typeof fetch>(async () =>
      Response.json({
        data: { ...authorityData([]), authorityWalletsError: "Wallet lookup denied" },
      })
    )
  );
  const { result } = renderData();
  await waitFor(() => expect(result.current.authorityWalletsError).toBe("Wallet lookup denied"));
  expect(result.current.authorityWalletsError).toBe("Wallet lookup denied");
  expect(result.current.authorityWallets).toEqual([]);
});

it("keeps wallet failure blocking even when previous inventories were cached", async () => {
  const fetchMock = vi.fn<typeof fetch>(async () =>
    Response.json({ data: authorityData([wallet]) })
  );
  vi.stubGlobal("fetch", fetchMock);
  const first = renderData();
  await waitFor(() => expect(first.result.current.authorityWalletsLoading).toBe(false));
  expect(first.result.current.authorityWallets).toEqual([wallet]);
  first.unmount();

  fetchMock.mockRejectedValue(new Error("Wallet inventory unavailable"));
  const second = renderData();
  await waitFor(() =>
    expect(second.result.current.authorityWalletsFetchError).toBe("Wallet inventory unavailable")
  );
  expect(second.result.current.authorityWalletsError).toBe("Wallet inventory unavailable");
  expect(second.result.current.authorityWallets).toEqual([]);
});
