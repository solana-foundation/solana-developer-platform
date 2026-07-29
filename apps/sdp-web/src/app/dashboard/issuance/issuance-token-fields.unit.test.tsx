import type { PaymentsDashboardWallet } from "@sdp/types";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { getMessages, type MessageKey, type TranslationValues, translate } from "@/i18n/messages";
import { I18nProvider } from "@/i18n/provider";
import type { AuthorityRoleKey } from "./asset-overview-hero";
import {
  buildOverviewHeroData,
  deploymentStatusBadge,
  getDeploymentStatus,
  getTokenChips,
  type IssuanceTokenView,
} from "./issuance-token-fields";
import { IssuanceTokenList } from "./issuance-token-list";
import { toWalletIdentity } from "./wallet-identity";

const messages = getMessages("en");
const t = (key: MessageKey, values?: TranslationValues) => translate(messages, key, values);

function renderWithI18n(children: ReactNode) {
  return renderToStaticMarkup(
    <I18nProvider locale="en" messages={messages}>
      {children}
    </I18nProvider>
  );
}

function baseToken(overrides: Partial<IssuanceTokenView> = {}): IssuanceTokenView {
  return {
    id: "tok_1",
    name: "Veritas Finance",
    symbol: "vUSD",
    status: "active",
    template: "stablecoin",
    imageUrl: null,
    mintAddress: null,
    totalSupply: "0",
    createdAt: "2026-07-17",
    deployedAt: null,
    decimals: 6,
    maxSupply: null,
    isMintable: true,
    isFreezable: true,
    requiresAllowlist: false,
    description: null,
    uri: null,
    signingWalletId: null,
    mintAuthority: null,
    metadataAuthority: null,
    freezeAuthority: null,
    permanentDelegate: null,
    assetProfile: null,
    ...overrides,
  };
}

function wallet(publicKey: string): PaymentsDashboardWallet {
  return {
    id: `id_${publicKey}`,
    walletId: `wid_${publicKey}`,
    publicKey,
    label: "Treasury",
  };
}

const stablecoinProfile: IssuanceTokenView["assetProfile"] = {
  assetCategory: "stablecoin",
  assetType: "fiat_backed",
  assetTypeVersion: 1,
  issuanceMetadata: {
    asset: {
      issuerName: "Veritas Finance",
      pegCurrency: "USD",
      pegTarget: "1.00 USD",
      reserveAsset: "Cash & short-dated US Treasury bills",
      reserveCustodian: "Meridian Trust Bank, N.A.",
      redemptionEnabled: true,
      website: "https://veritas.finance",
    },
  },
};

describe("buildOverviewHeroData", () => {
  const MANAGED = "MANAGEDpubkey1111111111111111111111111111111";
  const EXTERNAL = "EXTERNALpubkey222222222222222222222222222222";
  const rowFor = (data: ReturnType<typeof buildOverviewHeroData>, role: AuthorityRoleKey) =>
    data.authorityRows.find((authorityRow) => authorityRow.role === role);

  it("resolves each applicable authority's control against the org custody wallets", () => {
    const data = buildOverviewHeroData(
      baseToken({
        mintAuthority: MANAGED,
        freezeAuthority: MANAGED,
        metadataAuthority: MANAGED,
      }),
      [wallet(MANAGED)],
      t,
      "en"
    );

    // mint + freeze + metadata are set & custodied by the org → green (sdp).
    for (const role of ["mint", "freeze", "metadata"] as const) {
      const row = rowFor(data, role);
      expect(row?.applicable).toBe(true);
      expect(row?.address).toBe(MANAGED);
      expect(row?.control).toBe("sdp");
    }
    // The permanent delegate is unset → not applicable, so the glyph isn't drawn.
    expect(rowFor(data, "permanentDelegate")?.applicable).toBe(false);
  });

  it("marks an authority held outside the org as external", () => {
    const data = buildOverviewHeroData(
      baseToken({
        mintAuthority: MANAGED,
        freezeAuthority: EXTERNAL,
        metadataAuthority: MANAGED,
      }),
      [wallet(MANAGED)],
      t,
      "en"
    );

    expect(rowFor(data, "freeze")?.control).toBe("external");
    expect(rowFor(data, "mint")?.control).toBe("sdp");
    expect(rowFor(data, "metadata")?.control).toBe("sdp");
  });

  it("reports control as unknown when no custody wallets are loaded", () => {
    const data = buildOverviewHeroData(
      baseToken({ mintAuthority: MANAGED, freezeAuthority: MANAGED }),
      [],
      t,
      "en"
    );

    // Without wallets we can't classify custody → control "unknown" (muted glyph),
    // but the address itself is still resolvable from the row.
    const mint = rowFor(data, "mint");
    expect(mint?.control).toBe("unknown");
    expect(mint?.address).toBe(MANAGED);
  });

  // The authority popovers render the same compact identity badge as the signer
  // tile, so each row carries a resolved holder — not just a bare address.
  it("resolves an SDP-held authority to its named custody wallet", () => {
    const data = buildOverviewHeroData(
      baseToken({ mintAuthority: MANAGED }),
      [wallet(MANAGED)],
      t,
      "en"
    );

    expect(rowFor(data, "mint")?.identity).toEqual({
      state: "managed",
      name: "Treasury",
      provider: null,
      publicKey: MANAGED,
      walletId: `wid_${MANAGED}`,
    });
  });

  it("carries the bare address for an externally held authority", () => {
    const data = buildOverviewHeroData(
      baseToken({ mintAuthority: MANAGED, freezeAuthority: EXTERNAL }),
      [wallet(MANAGED)],
      t,
      "en"
    );

    expect(rowFor(data, "freeze")?.identity).toEqual({
      state: "external",
      publicKey: EXTERNAL,
    });
  });

  it("claims neither managed nor external while custody wallets are unknown", () => {
    const data = buildOverviewHeroData(baseToken({ mintAuthority: MANAGED }), [], t, "en");

    expect(rowFor(data, "mint")?.identity).toEqual({ state: "unknown", publicKey: MANAGED });
  });

  it("reports an unset authority as none", () => {
    const data = buildOverviewHeroData(baseToken(), [wallet(MANAGED)], t, "en");

    expect(rowFor(data, "permanentDelegate")?.identity).toEqual({ state: "none" });
  });

  it("formats a compact supply / max, using ∞ when uncapped", () => {
    expect(
      buildOverviewHeroData(
        baseToken({ totalSupply: "1000000", maxSupply: "2000000000" }),
        [],
        t,
        "en"
      ).supply
    ).toBe("1M / 2B");
    expect(buildOverviewHeroData(baseToken({ totalSupply: "0" }), [], t, "en").supply).toBe(
      "0 / ∞"
    );
  });

  it("resolves the signing wallet to its custody wallet", () => {
    const signer = wallet(MANAGED);
    const data = buildOverviewHeroData(
      baseToken({ signingWalletId: signer.walletId }),
      [signer],
      t,
      "en"
    );

    expect(data.signerWallet).toEqual({
      state: "managed",
      name: "Treasury",
      provider: null,
      publicKey: MANAGED,
      walletId: `wid_${MANAGED}`,
    });
  });

  // A signer is always a custody wallet (the API takes a walletId, resolved via
  // createOrgSigner), so the only non-managed states are "none pinned" and
  // "pinned but unresolvable".
  it("reports the project-default signer when no wallet is pinned", () => {
    const data = buildOverviewHeroData(
      baseToken({ signingWalletId: null }),
      [wallet(MANAGED)],
      t,
      "en"
    );

    expect(data.signerWallet).toEqual({ state: "default" });
  });

  it("flags a pinned signer that no longer resolves to a custody wallet", () => {
    const data = buildOverviewHeroData(
      baseToken({ signingWalletId: "wlt_removed" }),
      [wallet(MANAGED)],
      t,
      "en"
    );

    expect(data.signerWallet).toEqual({ state: "unresolved", walletId: "wlt_removed" });
  });

  it("stays neutral for a pinned signer while the custody wallets are unknown", () => {
    const data = buildOverviewHeroData(baseToken({ signingWalletId: "wlt_1" }), [], t, "en");

    expect(data.signerWallet).toBeNull();
  });

  it("derives issuer + up to four type-aware category tiles from the asset profile", () => {
    const data = buildOverviewHeroData(baseToken({ assetProfile: stablecoinProfile }), [], t, "en");

    expect(data.issuer).toBe("Veritas Finance");
    // Stablecoin candidates run currency → peg target → reserve asset → reserve
    // custodian, in that order. Callers with room for only three slice the tail off,
    // so the order matters more than the cap: it decides what a short card drops.
    expect(data.categoryTiles.map(({ label, value }) => ({ label, value }))).toEqual([
      { label: t("DashboardIssuance.config.currency"), value: "USD" },
      { label: t("DashboardIssuance.config.pegTarget"), value: "1.00 USD" },
      {
        label: t("DashboardIssuance.config.reserveAsset"),
        value: "Cash & short-dated US Treasury bills",
      },
      {
        label: t("DashboardIssuance.config.reserveCustodian"),
        value: "Meridian Trust Bank, N.A.",
      },
    ]);
    // Each field carries its own glyph, so no two tiles on a card look alike.
    expect(new Set(data.categoryTiles.map((tile) => tile.icon)).size).toBe(4);
  });

  it("yields no category tiles for a token without an asset profile", () => {
    expect(buildOverviewHeroData(baseToken(), [], t, "en").categoryTiles).toEqual([]);
  });

  it("splits the two dates so only one of them ever takes up space", () => {
    // Draft: the row shows Created, and there is no second date worth surfacing.
    const draft = buildOverviewHeroData(baseToken(), [], t, "en");
    expect(draft.date.label).toBe(t("DashboardIssuance.list.created"));
    expect(draft.secondaryDate).toBeNull();

    // Deployed: the row shows Deployed and the draft-created date moves into the
    // (i) hint beside it.
    const deployed = buildOverviewHeroData(baseToken({ deployedAt: "2026-07-22" }), [], t, "en");
    expect(deployed.date.label).toBe(t("DashboardIssuance.overview.deployed"));
    expect(deployed.secondaryDate?.label).toBe(t("DashboardIssuance.overview.draftCreated"));
    expect(deployed.secondaryDate?.value).not.toBe(deployed.date.value);
  });

  it("derives the website from the asset profile, or null without one", () => {
    expect(
      buildOverviewHeroData(baseToken({ assetProfile: stablecoinProfile }), [], t, "en").website
    ).toBe("https://veritas.finance");
    expect(buildOverviewHeroData(baseToken(), [], t, "en").website).toBeNull();
  });
});

// Deployment first, then the operator's own state. Paused used to collapse into
// "Active", which told an operator the opposite of what they had just done.
describe("getDeploymentStatus", () => {
  const deployed = { mintAddress: "MINT1111111111111111111111111111111111111111" };

  it("reports a deployed token as active", () => {
    expect(getDeploymentStatus(baseToken({ ...deployed, status: "active" }))).toBe("active");
  });

  it("reports a deployed token whose status is paused as paused", () => {
    expect(getDeploymentStatus(baseToken({ ...deployed, status: "paused" }))).toBe("paused");
  });

  it("keeps an undeployed token a draft whatever its status says", () => {
    expect(getDeploymentStatus(baseToken({ status: "paused" }))).toBe("draft");
    expect(getDeploymentStatus(baseToken({ status: "active" }))).toBe("draft");
  });

  it("gives paused its own label and the warning tint, not the live one", () => {
    const paused = deploymentStatusBadge("paused", t);
    const active = deploymentStatusBadge("active", t);
    expect(paused.label).toBe(t("DashboardIssuance.status.paused"));
    expect(paused.badge).toContain("warning");
    expect(active.badge).toContain("success");
  });
});

describe("getTokenChips", () => {
  it("uses category + subtype chips when a profile is present", () => {
    const chips = getTokenChips(baseToken({ assetProfile: stablecoinProfile }), t);
    const labels = chips.map((chip) => chip.label);
    expect(labels).toContain(t("DashboardIssuance.taxonomy.stablecoin"));
    expect(labels).toContain(t("DashboardIssuance.taxonomy.fiatBacked"));
  });

  it("falls back to a single template-derived chip without a profile", () => {
    const chips = getTokenChips(baseToken(), t);
    expect(chips).toHaveLength(1);
    expect(chips[0].label).toBe(t("DashboardIssuance.templates.stablecoinName"));
  });
});

// The same raw address means different things depending on who is asking, so the
// caller — not the payload — decides the framing. Reporting existing on-chain
// state is a warning ("Held externally"); previewing typed input is neutral
// ("Custom address"). See the authority modal, which renders both at once.
describe("toWalletIdentity", () => {
  const ADDRESS = "EXTERNALpubkey222222222222222222222222222222";
  const unlabeled = t("DashboardIssuance.wallet.unlabeled");

  it("resolves a custody wallet to managed, carrying its walletId", () => {
    const signer = wallet("MANAGEDpubkey1111111111111111111111111111111");
    expect(toWalletIdentity(signer, null, { unresolvedAs: "external", unlabeled })).toEqual({
      state: "managed",
      name: "Treasury",
      provider: null,
      publicKey: signer.publicKey,
      walletId: signer.walletId,
    });
  });

  it("frames an unresolved address by the caller's intent", () => {
    expect(toWalletIdentity(null, ADDRESS, { unresolvedAs: "external", unlabeled })).toEqual({
      state: "external",
      publicKey: ADDRESS,
    });
    expect(toWalletIdentity(null, ADDRESS, { unresolvedAs: "custom", unlabeled })).toEqual({
      state: "custom",
      publicKey: ADDRESS,
    });
  });

  it("treats a blank address as none regardless of framing", () => {
    expect(toWalletIdentity(null, "   ", { unresolvedAs: "custom", unlabeled })).toEqual({
      state: "none",
    });
    expect(toWalletIdentity(null, null, { unresolvedAs: "external", unlabeled })).toEqual({
      state: "none",
    });
  });
});

describe("IssuanceTokenList", () => {
  it("renders each token's symbol, name and a manage affordance without crashing", () => {
    const markup = renderWithI18n(
      <IssuanceTokenList
        tokens={[baseToken({ assetProfile: stablecoinProfile })]}
        signerWallets={[]}
        openIds={new Set()}
        onToggle={() => undefined}
        onCreate={() => undefined}
      />
    );
    expect(markup).toContain("vUSD");
    expect(markup).toContain("Veritas Finance");
    expect(markup).toContain(t("DashboardIssuance.workspace.manage"));
    // Collapsed row shows the taxonomy chip.
    expect(markup).toContain(t("DashboardIssuance.taxonomy.fiatBacked"));
    // …and keeps Decimals: the row's stat cells are a column, so every row states the
    // same fact there. Per-asset data belongs to the grid tile, which has no column.
    expect(markup).toContain(t("DashboardIssuance.list.decimals"));
  });

  it("renders the footer inside the list so it can be displaced with the rows", () => {
    const markup = renderWithI18n(
      <IssuanceTokenList
        tokens={[baseToken({ assetProfile: stablecoinProfile })]}
        signerWallets={[]}
        openIds={new Set()}
        onToggle={() => undefined}
        onCreate={() => undefined}
        footer={<span data-testid="list-footer">pager</span>}
      />
    );
    // Expanded panels are absolute and the rows below only translate, so the list's
    // box never grows: a footer rendered *after* the list would be stranded
    // mid-list once a row opened. It has to be inside, carrying the same translate
    // as the rows — and on the ladder's top rung, so the last row's panel slides
    // out from under it.
    expect(markup).toMatch(
      /<div style="margin-top:-10px;transform:translateY\(0px\);transition:transform \d+ms [^"]*;z-index:1"><span data-testid="list-footer"/
    );
  });

  it("keeps closed detail panels out of the keyboard tab order", () => {
    // Panels stay mounted for the compositor-only reveal, so each closed one must
    // carry `inert`; opacity and pointer-events hide it visually but leave its
    // explorer/Manage links tabbable. Asserted against the markup string because
    // this suite runs in the `node` environment — there is no DOM to focus-test.
    const markup = renderWithI18n(
      <IssuanceTokenList
        tokens={[baseToken(), baseToken({ id: "tok_2", symbol: "vEUR", name: "Veritas Euro" })]}
        signerWallets={[]}
        openIds={new Set()}
        onToggle={() => undefined}
        onCreate={() => undefined}
      />
    );
    expect(markup.match(/inert=""/g) ?? []).toHaveLength(2);
    // The Manage link lives inside the panel, i.e. after its inert attribute.
    expect(markup.indexOf(t("DashboardIssuance.list.manageThisAsset"))).toBeGreaterThan(
      markup.indexOf('inert=""')
    );
  });
});
