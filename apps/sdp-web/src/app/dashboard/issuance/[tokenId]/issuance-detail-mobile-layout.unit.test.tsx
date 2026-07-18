import type { AssetProfile, Token } from "@sdp/types";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { getMessages } from "@/i18n/messages";
import { I18nProvider } from "@/i18n/provider";
import { AssetProfileHeader } from "./asset-profile/asset-profile-header";
import { TokenManagementHeader } from "./token-management-header";

const TOKEN_ID = "tok_d106fe22-8311-4ba6-babf-7b7082bb0529";

const token = {
  id: TOKEN_ID,
  projectId: "prj_operations_route_loading",
  organizationId: "org_operations_route_loading",
  signingWalletId: null,
  mintAddress: null,
  mintAuthority: null,
  freezeAuthority: null,
  ablListAddress: null,
  name: "Codex loading visual draft",
  symbol: "CLVD",
  decimals: 6,
  description: null,
  uri: null,
  imageUrl: null,
  template: "stablecoin",
  extensions: null,
  totalSupply: "0",
  maxSupply: null,
  isMintable: true,
  isFreezable: false,
  requiresAllowlist: false,
  status: "pending",
  deployedAt: null,
  createdBy: "usr_operations_route_loading",
  createdAt: "2026-07-18T00:00:00.000Z",
  updatedAt: "2026-07-18T00:00:00.000Z",
} satisfies Token;

const assetProfile = {
  id: "asp_operations_route_loading",
  organizationId: token.organizationId,
  projectId: token.projectId,
  tokenId: token.id,
  assetCategory: "stablecoin",
  assetType: "fiat_backed",
  assetTypeVersion: 1,
  issuanceMetadata: {},
  publicMetadata: {},
  status: "active",
  createdBy: token.createdBy,
  createdAt: token.createdAt,
  updatedAt: token.updatedAt,
} satisfies AssetProfile;

function noop() {}

function renderHeaders(): string {
  return renderToStaticMarkup(
    <I18nProvider locale="en" messages={getMessages("en")}>
      <TokenManagementHeader
        tokenId={token.id}
        tokenName={token.name}
        tokenSymbol={token.symbol}
        tokenStatus={token.status}
        tokenAddress={token.mintAddress}
        tokenImageUrl={token.imageUrl}
        explorerHref={null}
        canDeployToken={false}
        canManageTokenAdmin={false}
        isPending={false}
        onCopyAddress={noop}
        onCopyTokenId={noop}
        onDeploy={noop}
        onUnpause={noop}
      />
      <AssetProfileHeader
        token={token}
        assetProfile={assetProfile}
        explorerHref={null}
        canDeployToken={false}
        canManageTokenAdmin={false}
        isPending={false}
        onCopyAddress={noop}
        onCopyTokenId={noop}
        onDeploy={noop}
        onUnpause={noop}
      />
    </I18nProvider>
  );
}

describe("issuance detail mobile layout", () => {
  it("allows a full token ID to shrink and wrap in both settled headers", () => {
    const markup = renderHeaders();

    expect(markup.match(/data-testid="token-id-row"/g)).toHaveLength(2);
    expect(markup.match(/data-token-id-value/g)).toHaveLength(2);
    expect(
      markup.match(/<span class="[^"]*min-w-0[^"]*break-all[^"]*" data-token-id-value/g)
    ).toHaveLength(2);
  });
});
