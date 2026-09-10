import type { AssetProfile, Token } from "@sdp/types";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { getMessages } from "@/i18n/messages";
import { I18nProvider } from "@/i18n/provider";
import { AssetProfileHeader } from "../asset-profile-header";
import type { TokenOperations } from "../use-token-operations";
import { OperationsTab } from "./operations-tab";

const token: Token = {
  id: "tok_review",
  projectId: "prj_review",
  organizationId: "org_review",
  signingWalletId: null,
  signingCustodyWalletId: null,
  mintAddress: "58NU6ZxKq3aVv2q1s9bJcYtvHkbEwLmPqRs4TuVwVjVu",
  mintAuthority: "wallet-address",
  freezeAuthority: "wallet-address",
  ablListAddress: null,
  name: "Veritas USD",
  symbol: "vUSD",
  decimals: 6,
  description: null,
  uri: null,
  imageUrl: null,
  template: "stablecoin",
  extensions: { permanentDelegate: "wallet-address", pausable: { authority: "wallet-address" } },
  totalSupply: "2500000",
  maxSupply: "10000000",
  isMintable: true,
  isFreezable: true,
  requiresAllowlist: false,
  status: "active",
  deployedAt: "2026-09-04T16:00:00Z",
  createdBy: "usr_review",
  createdAt: "2026-09-04T16:00:00Z",
  updatedAt: "2026-09-04T16:00:00Z",
};
const profile: AssetProfile = {
  id: "asp_review",
  organizationId: token.organizationId,
  projectId: token.projectId,
  tokenId: token.id,
  assetCategory: "stablecoin",
  assetType: "stablecoin_generic",
  assetTypeVersion: 1,
  issuanceMetadata: {},
  publicMetadata: {},
  status: "active",
  createdBy: token.createdBy,
  createdAt: token.createdAt,
  updatedAt: token.updatedAt,
};
// Only the entry-point state is consumed while every operation dialog is closed.
function makeOps(overrides: Partial<TokenOperations> = {}): TokenOperations {
  return {
    isPending: false,
    canDeployToken: false,
    deployDisabledReason: null,
    showControlList: true,
    effectivePauseDisabledReason: null,
    effectiveFreezeDisabledReason: null,
    operationAvailability: { mint: null, burn: null, seize: null, "force-burn": null },
    lockSupplyRemaining: "7500000",
    lockSupplyDisabledReason: null,
    openFundManagementModal: vi.fn(),
    openLockSupplyModal: vi.fn(),
    deployToken: vi.fn(),
    handlePause: vi.fn(),
    ...overrides,
  } as TokenOperations;
}

function render(input: Token = token, overrides: Partial<TokenOperations> = {}, admin = true) {
  return renderToStaticMarkup(
    <I18nProvider locale="en" messages={getMessages("en")}>
      <main className="mx-auto max-w-5xl space-y-6 p-6 sm:p-10">
        <AssetProfileHeader
          token={input}
          assetProfile={profile}
          explorerHref={null}
          canDeployToken={false}
          canManageTokenAdmin={admin}
          isPending={false}
          onCopyAddress={vi.fn()}
          onCopyTokenId={vi.fn()}
          onDeploy={vi.fn()}
          onUnpause={vi.fn()}
        />
        <div className="flex gap-8 overflow-x-auto border-b border-border-default pb-4 text-sm text-tertiary">
          <span>Overview</span>
          <span className="text-primary">Operations</span>
          <span>Permissions</span>
          <span>Activity</span>
          <span>Settings</span>
        </div>
        <OperationsTab token={input} ops={makeOps(overrides)} canManageTokenAdmin={admin} />
      </main>
    </I18nProvider>
  );
}

describe("simplified token operations", () => {
  it("groups live actions and keeps recovery collapsed", () => {
    const html = render();
    expect(html).toContain('data-testid="fund-management-row-mint"');
    expect(html).toContain("Blocked recipients");
    expect(html).toContain("Pause transfers");
    expect(html).toContain("Freeze a balance");
    expect(html).toContain('aria-expanded="false"');
    expect(html).toContain('aria-hidden="true" inert=""');
    expect(html).not.toContain('data-slot="card"');
  });

  it("shows disabled operations for a draft", () => {
    const html = render(
      { ...token, mintAddress: null, status: "pending" },
      { canDeployToken: true }
    );
    expect(html).toContain("Deploy this token first");
    expect(html).toContain('data-testid="fund-management-row-mint"');
  });

  it("does not duplicate the header deploy action", () => {
    const html = render(
      { ...token, mintAddress: null, status: "pending" },
      { canDeployToken: true }
    );
    expect(html).not.toContain(">Deploy<");
    expect(html).toMatch(/aria-label="Mint tokens"[^>]*disabled=""/);
  });

  it("keeps recipient lists readable while hiding privileged actions from non-admins", () => {
    const html = render(token, {}, false);
    expect(html).toContain("Blocked recipients");
    expect(html).not.toContain('data-testid="fund-management-row-freeze"');
    expect(html).not.toContain("Recovery &amp; permanent changes");
  });

  it("omits unsupported controls for a custom token", () => {
    const html = render(
      { ...token, template: "custom", extensions: null, isFreezable: false },
      { showControlList: false, lockSupplyRemaining: null }
    );
    expect(html).not.toContain("No transfer controls are enabled");
    expect(html).not.toContain(">Transfers</h3>");
    expect(html).not.toContain("Recovery &amp; permanent changes");
  });

  it("shows capability blockers alongside the operation", () => {
    const html = render(token, {
      operationAvailability: {
        mint: "Maximum supply reached",
        burn: null,
        seize: null,
        "force-burn": null,
      },
    });
    expect(html).toContain("Maximum supply reached");
  });

  it("keeps pause available for a deployed stablecoin without cached extension metadata", () => {
    const html = render({ ...token, extensions: null });
    expect(html).toContain('data-testid="fund-management-row-pause"');
  });
});
