import type { AssetProfile, Token } from "@sdp/types";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { getMessages } from "@/i18n/messages";
import { I18nProvider } from "@/i18n/provider";
import { shortenAddress, shortenPrefixedId } from "../../wallet-identity";
import { AssetProfileHeader } from "./asset-profile-header";

const token = {
  id: "tok_3e04a7b4-6277-4d4d-bdab-d26ae5075167",
  projectId: "prj_x",
  organizationId: "org_x",
  signingWalletId: null,
  mintAddress: null,
  mintAuthority: null,
  freezeAuthority: null,
  ablListAddress: null,
  name: "Unicorn ETF",
  symbol: "testUSD",
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
  createdBy: "usr_x",
  createdAt: "2026-07-18T00:00:00.000Z",
  updatedAt: "2026-07-18T00:00:00.000Z",
} satisfies Token;

const deployed = {
  ...token,
  status: "active" as const,
  mintAddress: "58NU6ZxKq3aVv2q1s9bJcYtvHkbEwLmPqRs4TuVwVjVu",
  imageUrl: "https://example.test/unicorn.png",
  deployedAt: "2026-07-22T00:00:00.000Z",
};

const assetProfile = {
  id: "asp_x",
  organizationId: token.organizationId,
  projectId: token.projectId,
  tokenId: token.id,
  assetCategory: "tokenized_security",
  assetType: "debt_bond",
  assetTypeVersion: 1,
  issuanceMetadata: {},
  publicMetadata: {},
  status: "active",
  createdBy: token.createdBy,
  createdAt: token.createdAt,
  updatedAt: token.updatedAt,
} satisfies AssetProfile;

function noop() {}

function render(
  tokenInput: Token,
  overrides: Partial<{
    explorerHref: string | null;
    canDeployToken: boolean;
    canManageTokenAdmin: boolean;
  }> = {}
) {
  return renderToStaticMarkup(
    <I18nProvider locale="en" messages={getMessages("en")}>
      <AssetProfileHeader
        token={tokenInput}
        assetProfile={assetProfile}
        explorerHref={null}
        canDeployToken={false}
        canManageTokenAdmin={false}
        isPending={false}
        {...overrides}
        onCopyAddress={noop}
        onCopyTokenId={noop}
        onDeploy={noop}
        onUnpause={noop}
      />
    </I18nProvider>
  );
}

describe("asset profile header", () => {
  it("keeps the token-id contract, deployed and not", () => {
    for (const tokenInput of [token, deployed]) {
      const markup = render(tokenInput, { explorerHref: "https://explorer.test/x" });
      const values = [
        ...markup.matchAll(/<span class="([^"]*)" data-token-id-value([^>]*)>([^<]*)</g),
      ].map((m) => ({ className: m[1] ?? "", attributes: m[2] ?? "", text: m[3] ?? "" }));

      expect(markup.match(/data-testid="token-id-row"/g)).toHaveLength(1);
      expect(values).toHaveLength(1);
      // Elided like the address beside it, never wrapped: the full id is on the
      // element itself, which is also what the copy button puts on the clipboard.
      expect(values[0]?.text).toBe(shortenPrefixedId(tokenInput.id));
      expect(values[0]?.attributes).toContain(`title="${tokenInput.id}"`);
      expect(values[0]?.className).not.toContain("[overflow-wrap:anywhere]");
      expect(values[0]?.className).not.toContain("break-all");
      expect(markup).toContain(tokenInput.name);
      expect(markup).toContain(tokenInput.symbol);
    }
  });

  it("shows the elided mint only once deployed, with no placeholder before it", () => {
    expect(render(token)).not.toContain("Not deployed");
    expect(render(token)).not.toContain(">Mint<");

    const markup = render(deployed);
    expect(markup).toContain(">Mint<");
    expect(markup).toContain(shortenAddress(deployed.mintAddress));
    expect(markup).toContain(`title="${deployed.mintAddress}"`);
  });

  it("carries classification, status, and the deploy date on one meta line", () => {
    const markup = render(deployed);
    expect(markup).toContain("Tokenized Security");
    expect(markup).toContain("Active");
    expect(markup).toContain("Deployed Jul 22, 2026");

    // A draft has no deploy date to speak of, but still says what it is.
    const draft = render(token);
    expect(draft).toContain("Draft");
    expect(draft).not.toContain("Deployed");
  });

  it("never recases the symbol chip", () => {
    const chip = render(deployed).match(
      /<span class="([^"]*)"><span class="sr-only">Ticker <\/span>([^<]*)<\/span>/
    );
    const [, chipClasses = "", renderedSymbol = ""] = chip ?? [];
    expect(renderedSymbol).toBe(deployed.symbol);
    expect(chipClasses).not.toContain("uppercase");
    expect(chipClasses).not.toContain("capitalize");
  });

  it("falls back to a monogram mark when the asset has no artwork", () => {
    expect(render(token)).toContain(">t</div>");
    expect(render(deployed)).toContain(deployed.imageUrl);
  });

  it("renders the explorer action only with a destination", () => {
    expect(render(deployed, { explorerHref: "https://explorer.test/x" })).toContain(
      "https://explorer.test/x"
    );
    expect(render(deployed)).not.toContain("Explorer");
  });

  it("offers the state action the viewer can actually take", () => {
    expect(render(token, { canDeployToken: true })).toContain("Deploy");
    expect(render(token)).not.toContain("Deploy");

    const paused = { ...deployed, status: "paused" as const };
    expect(render(paused, { canManageTokenAdmin: true })).toContain("Unpause");
    expect(render(paused)).not.toContain("Unpause");
  });
});
