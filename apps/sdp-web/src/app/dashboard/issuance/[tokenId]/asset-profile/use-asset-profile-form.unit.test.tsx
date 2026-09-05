// @vitest-environment jsdom

import type { AssetProfile, Token } from "@sdp/types";
import { act, cleanup, renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getMessages } from "@/i18n/messages";
import { I18nProvider } from "@/i18n/provider";
import { useAssetProfileForm } from "./use-asset-profile-form";

const mocks = vi.hoisted(() => ({
  refresh: vi.fn(),
  updateAssetProfile: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: mocks.refresh }),
}));
vi.mock("sonner", () => ({
  toast: { error: vi.fn(), success: vi.fn() },
}));
vi.mock("./actions", () => ({
  updateAssetProfileAction: mocks.updateAssetProfile,
}));

const token: Token = {
  id: "tok_legacy",
  projectId: "prj_test",
  organizationId: "org_test",
  signingCustodyWalletId: null,
  signingWalletId: "legacy_provider_wallet",
  mintAddress: "Mint111111111111111111111111111111111111111",
  mintAuthority: "Authority1111111111111111111111111111111111",
  metadataAuthority: "Authority1111111111111111111111111111111111",
  freezeAuthority: null,
  ablListAddress: null,
  name: "Verde Dollar",
  symbol: "VUSD",
  decimals: 6,
  description: "Original description",
  uri: "https://example.com/metadata.json",
  imageUrl: "https://example.com/logo.png",
  template: "stablecoin",
  extensions: { permanentDelegate: "Delegate111111111111111111111111111111111" },
  totalSupply: "100",
  maxSupply: null,
  isMintable: true,
  isFreezable: false,
  requiresAllowlist: false,
  status: "active",
  deployedAt: "2025-01-01T00:00:00.000Z",
  createdBy: "user_test",
  createdAt: "2025-01-01T00:00:00.000Z",
  updatedAt: "2025-01-01T00:00:00.000Z",
};

const assetProfile: AssetProfile = {
  id: "asset_profile_legacy",
  organizationId: "org_test",
  projectId: "prj_test",
  tokenId: token.id,
  assetCategory: "stablecoin",
  assetType: "fiat_backed",
  assetTypeVersion: 1,
  issuanceMetadata: {
    asset: {
      description: token.description ?? undefined,
      issuerName: "Verde Inc",
      pegCurrency: "USD",
      website: "https://verde.example",
    },
    settings: { selected: { permanentDelegate: {} } },
  },
  publicMetadata: {},
  status: "active",
  createdBy: "user_test",
  createdAt: "2025-01-01T00:00:00.000Z",
  updatedAt: "2025-01-01T00:00:00.000Z",
};

const metadataSignerSelection = {
  wallets: [
    {
      id: "cwlt_metadata",
      walletId: "provider_metadata",
      publicKey: token.metadataAuthority ?? "",
      label: "Metadata signer",
    },
  ],
  defaultWalletId: "cwlt_metadata",
  unavailableReason: null,
};

function wrapper({ children }: { children: ReactNode }) {
  return (
    <I18nProvider locale="en" messages={getMessages("en")}>
      {children}
    </I18nProvider>
  );
}

beforeEach(() => {
  mocks.refresh.mockReset();
  mocks.updateAssetProfile.mockReset();
  mocks.updateAssetProfile.mockResolvedValue({
    state: "success",
    message: "Saved",
    assetProfile: null,
  });
});

afterEach(cleanup);

describe("useAssetProfileForm", () => {
  it("saves an unrelated edit to a deployed legacy permanent-delegate token", async () => {
    const rendered = renderHook(
      () => useAssetProfileForm({ token, assetProfile, metadataSignerSelection }),
      { wrapper }
    );

    expect(rendered.result.current.draft.signingWalletId).toBe("");
    act(() => rendered.result.current.updateDraft({ website: "https://new.verde.example" }));

    expect(rendered.result.current.dirty).toBe(true);
    expect(rendered.result.current.errorCount).toBe(0);

    await act(() => rendered.result.current.save());

    expect(mocks.updateAssetProfile).toHaveBeenCalledOnce();
    expect(mocks.updateAssetProfile).toHaveBeenCalledWith(
      expect.objectContaining({
        tokenPatch: expect.objectContaining({ signingCustodyWalletId: "cwlt_metadata" }),
      })
    );
  });

  it("requires an exact metadata signer choice without changing the historical deployment wallet", async () => {
    const selection = {
      ...metadataSignerSelection,
      wallets: [
        ...metadataSignerSelection.wallets,
        { ...metadataSignerSelection.wallets[0], id: "cwlt_second", label: "Second signer" },
      ],
      defaultWalletId: "",
    };
    const rendered = renderHook(
      () => useAssetProfileForm({ token, assetProfile, metadataSignerSelection: selection }),
      { wrapper }
    );
    act(() => rendered.result.current.updateDraft({ description: "Updated metadata" }));
    await act(() => rendered.result.current.save());
    expect(mocks.updateAssetProfile).not.toHaveBeenCalled();

    act(() => rendered.result.current.setMetadataSignerWalletId("cwlt_second"));
    await act(() => rendered.result.current.save());
    expect(mocks.updateAssetProfile).toHaveBeenCalledWith(
      expect.objectContaining({
        tokenPatch: expect.objectContaining({ signingCustodyWalletId: "cwlt_second" }),
      })
    );
    expect(rendered.result.current.draft.signingWalletId).toBe("");
  });

  it("keeps the deployment-wallet requirement for an undeployed token", async () => {
    const pendingToken = { ...token, mintAddress: null, status: "pending" as const };
    const rendered = renderHook(
      () => useAssetProfileForm({ token: pendingToken, assetProfile, metadataSignerSelection }),
      {
        wrapper,
      }
    );

    act(() => rendered.result.current.updateDraft({ website: "https://new.verde.example" }));

    expect(rendered.result.current.errors.signingWalletId).toBeDefined();
    await act(() => rendered.result.current.save());
    expect(mocks.updateAssetProfile).not.toHaveBeenCalled();
  });

  it("preserves edits and requires an explicit replacement after the chosen signer disappears", async () => {
    const multiple = {
      ...metadataSignerSelection,
      defaultWalletId: "",
      wallets: [
        ...metadataSignerSelection.wallets,
        { ...metadataSignerSelection.wallets[0], id: "cwlt_removed" },
      ],
    };
    const rendered = renderHook(
      ({ selection }) =>
        useAssetProfileForm({ token, assetProfile, metadataSignerSelection: selection }),
      {
        wrapper,
        initialProps: { selection: multiple },
      }
    );
    act(() => {
      rendered.result.current.updateDraft({ description: "Keep these edits" });
      rendered.result.current.setMetadataSignerWalletId("cwlt_removed");
    });
    rendered.rerender({ selection: metadataSignerSelection });
    expect(rendered.result.current.metadataSignerWalletId).toBe("cwlt_removed");
    await act(() => rendered.result.current.save());
    expect(mocks.updateAssetProfile).not.toHaveBeenCalled();
    act(() => rendered.result.current.setMetadataSignerWalletId("cwlt_metadata"));
    await act(() => rendered.result.current.save());
    expect(mocks.updateAssetProfile).toHaveBeenCalledWith(
      expect.objectContaining({
        tokenPatch: expect.objectContaining({
          description: "Keep these edits",
          signingCustodyWalletId: "cwlt_metadata",
        }),
      })
    );
  });
});
