import type { AssetProfile, Token } from "@sdp/types";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { getMessages } from "@/i18n/messages";
import { I18nProvider } from "@/i18n/provider";
import { AssetProfileHeader } from "./asset-profile/asset-profile-header";
import { TokenManagementHeader } from "./token-management-header";
import { TokenOverviewSection } from "./token-overview-section";

const TOKEN_ID = "tok_d106fe22-8311-4ba6-babf-7b7082bb0529";
const TOKEN_ADDRESS = "2rN6gKUTbzwafECJP7yRRkB6vk5jiyoYrgNtifCttm8u";
const MINT_AUTHORITY = "F6zprzxgL3gsK19vuj6oYJPpsqbRgSzY7tR4c9vZ4m8Y";

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

function renderOverviewWithLongAddresses(): string {
  return renderToStaticMarkup(
    <I18nProvider locale="en" messages={getMessages("en")}>
      <TokenOverviewSection
        token={{ ...token, mintAddress: TOKEN_ADDRESS, status: "active" }}
        showTitle={false}
        mintAuthorityValue={MINT_AUTHORITY}
      />
    </I18nProvider>
  );
}

describe("issuance detail mobile layout", () => {
  it("keeps the full token ID reachable without letting it set either header's width", () => {
    const markup = renderHeaders();
    // className, then any remaining attributes, then the rendered value.
    const tokenIdValues = [
      ...markup.matchAll(/<span class="([^"]*)" data-token-id-value([^>]*)>([^<]*)</g),
    ].map((match) => ({
      className: match[1] ?? "",
      attributes: match[2] ?? "",
      text: (match[3] ?? "").trim(),
    }));

    expect(markup.match(/data-testid="token-id-row"/g)).toHaveLength(2);
    expect(tokenIdValues).toHaveLength(2);

    // The legacy header prints the id whole, so it needs somewhere to break: at the
    // dashes first, anywhere only if that isn't enough, never mid-segment by default.
    const [legacy, assetProfile] = tokenIdValues;
    expect(legacy?.text).toBe(TOKEN_ID);
    expect(legacy?.className).toContain("min-w-0");
    expect(legacy?.className).toContain("[overflow-wrap:anywhere]");
    expect(legacy?.className).not.toContain("break-all");

    // The asset-profile header elides the middle instead, like the address it sits
    // beside — one line at any width, whole value on hover and on the clipboard.
    expect(assetProfile?.text).toBe("tok_d106fe22…0529");
    expect(assetProfile?.attributes).toContain(`title="${TOKEN_ID}"`);
    expect(assetProfile?.className).not.toContain("[overflow-wrap:anywhere]");
  });

  it("contains long overview addresses while exposing their full values", () => {
    const markup = renderOverviewWithLongAddresses();
    const rowClasses = [
      ...markup.matchAll(
        /data-testid="overview-row-(?:token-address|mint-authority)" class="([^"]*)"/g
      ),
    ].map((match) => match[1] ?? "");
    const longValueElements = [...markup.matchAll(/<p class="([^"]*)" title="([^"]*)">/g)]
      .filter((match) => match[2] === TOKEN_ADDRESS || match[2] === MINT_AUTHORITY)
      .map((match) => ({ className: match[1] ?? "", title: match[2] ?? "" }));

    expect(rowClasses).toHaveLength(2);
    expect(rowClasses.every((className) => className.includes("min-w-0"))).toBe(true);
    expect(rowClasses.every((className) => className.includes("justify-between"))).toBe(true);
    expect(longValueElements).toHaveLength(2);
    expect(longValueElements.map(({ title }) => title)).toEqual([TOKEN_ADDRESS, MINT_AUTHORITY]);
    expect(
      longValueElements.every(
        ({ className }) =>
          className.includes("min-w-0") &&
          className.includes("truncate") &&
          className.includes("text-right")
      )
    ).toBe(true);
    expect(
      markup.match(/<p class="[^"]*shrink-0[^"]*">(?:Token Address|Mint Authority)<\/p>/g)
    ).toHaveLength(2);
  });
});
