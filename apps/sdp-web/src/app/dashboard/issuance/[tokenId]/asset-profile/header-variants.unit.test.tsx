// TEMP: guards the header variant preview switcher while a layout is being
// chosen. Delete this file together with HEADER_LAYOUTS and the losing variants.
import type { AssetProfile, Token } from "@sdp/types";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { getMessages } from "@/i18n/messages";
import { I18nProvider } from "@/i18n/provider";
import { HEADER_LAYOUTS } from "./asset-profile-header";

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

const deployed = {
  ...token,
  status: "active" as const,
  mintAddress: "58NU6ZxKq3aVv2q1s9bJcYtvHkbEwLmPqRs4TuVwVjVu",
  imageUrl: "https://example.test/unicorn.png",
};

function render(variant: keyof typeof HEADER_LAYOUTS, tokenInput: Token, explorer: string | null) {
  const Layout = HEADER_LAYOUTS[variant];
  return renderToStaticMarkup(
    <I18nProvider locale="en" messages={getMessages("en")}>
      <Layout
        token={tokenInput}
        assetProfile={assetProfile}
        explorerHref={explorer}
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

describe("header variant smoke", () => {
  const variants = Object.keys(HEADER_LAYOUTS) as (keyof typeof HEADER_LAYOUTS)[];

  it("covers all seven variants", () => {
    expect(variants).toEqual(["A", "B", "C", "D", "E", "F", "G"]);
  });

  for (const variant of variants) {
    it(`${variant}: renders undeployed and deployed without breaking the token-id contract`, () => {
      for (const [tokenInput, explorer] of [
        [token, null],
        [deployed, "https://explorer.test/x"],
      ] as const) {
        const markup = render(variant, tokenInput, explorer);
        const valueClasses = [...markup.matchAll(/<span class="([^"]*)" data-token-id-value/g)].map(
          (m) => m[1] ?? ""
        );

        expect(markup.match(/data-testid="token-id-row"/g), `${variant} row count`).toHaveLength(1);
        expect(valueClasses, `${variant} value span`).toHaveLength(1);
        expect(valueClasses[0]).toContain("min-w-0");
        expect(valueClasses[0]).toContain("[overflow-wrap:anywhere]");
        expect(valueClasses[0]).not.toContain("break-all");
        expect(markup).toContain(token.id);
        expect(markup).toContain("Unicorn ETF");
      }
    });

    it(`${variant}: shows the undeployed state and the shortened address when deployed`, () => {
      expect(render(variant, token, null)).toContain("Not deployed");
      const deployedMarkup = render(variant, deployed, "https://explorer.test/x");
      // Variants A/B/C print the full address; D-G print the 5/4 shortened form.
      const showsAddress =
        deployedMarkup.includes(deployed.mintAddress) || deployedMarkup.includes("58NU6…VjVu");
      expect(showsAddress, `${variant} address`).toBe(true);
    });
  }
});
