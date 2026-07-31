import type { AssetProfile, Token } from "@sdp/types";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { getMessages } from "@/i18n/messages";
import { I18nProvider } from "@/i18n/provider";
import { shortenPrefixedId } from "../../wallet-identity";
import { AssetProfileHeaderCard } from "./asset-profile-header";
import { HEADER_APPEARANCE_DEFAULTS, type HeaderAppearance } from "./header-appearance";

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

const APPEARANCES: Pick<HeaderAppearance, "layout" | "mode">[] = [
  { layout: "default", mode: "default" },
  { layout: "default", mode: "expanded" },
  { layout: "mirrored", mode: "default" },
  { layout: "mirrored", mode: "expanded" },
];

// Only the axes a case is about, over the defaults every user gets.
function render(
  tokenInput: Token,
  appearance: Partial<HeaderAppearance> = {},
  explorerHref: string | null = null
) {
  return renderToStaticMarkup(
    <I18nProvider locale="en" messages={getMessages("en")}>
      <AssetProfileHeaderCard
        appearance={{ ...HEADER_APPEARANCE_DEFAULTS, ...appearance }}
        token={tokenInput}
        assetProfile={assetProfile}
        explorerHref={explorerHref}
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

const separators = (markup: string) =>
  markup.match(/class="hidden h-3 w-px bg-border-subtle sm:block"/g)?.length ?? 0;

describe("asset profile header", () => {
  for (const appearance of APPEARANCES) {
    const name = `${appearance.layout}/${appearance.mode}`;

    it(`${name}: keeps the token-id contract, deployed and not`, () => {
      for (const tokenInput of [token, deployed]) {
        const markup = render(tokenInput, appearance, "https://explorer.test/x");
        const values = [
          ...markup.matchAll(/<span class="([^"]*)" data-token-id-value([^>]*)>([^<]*)</g),
        ].map((m) => ({ className: m[1] ?? "", attributes: m[2] ?? "", text: m[3] ?? "" }));

        expect(markup.match(/data-testid="token-id-row"/g), `${name} row count`).toHaveLength(1);
        expect(values, `${name} value span`).toHaveLength(1);
        // Elided like the address beside it, never wrapped: the full id is on the
        // element itself, which is also what the copy button puts on the clipboard.
        expect(values[0]?.text, `${name} elided id`).toBe(shortenPrefixedId(tokenInput.id));
        expect(values[0]?.attributes).toContain(`title="${tokenInput.id}"`);
        expect(values[0]?.className).not.toContain("[overflow-wrap:anywhere]");
        expect(values[0]?.className).not.toContain("break-all");
        expect(markup).toContain(tokenInput.id);
        expect(markup).toContain(tokenInput.name);
        expect(markup).toContain(tokenInput.symbol);
      }
    });

    it(`${name}: puts the mark and everything positioned against it on one side`, () => {
      const markup = render(deployed, appearance, "https://explorer.test/x");
      const mirrored = appearance.layout === "mirrored";

      // The mark bleeds off its own edge; the ticker sits just inside it.
      expect(markup, `${name} mark`).toContain(mirrored ? "-right-10" : "-left-10");
      expect(markup, `${name} ticker inset`).toMatch(
        mirrored ? /right-\[\d+px\]/ : /left-\[\d+px\]/
      );
      // Reserved clearance is on the mark's side, and only in expanded.
      if (appearance.mode === "expanded") {
        expect(markup, `${name} clearance`).toContain(mirrored ? "lg:pr-64" : "lg:pl-64");
      } else {
        expect(markup, `${name} clearance`).not.toMatch(/lg:p[lr]-\d+/);
      }
    });
  }

  it("the default mode floats the actions to the corner away from the mark", () => {
    const floating = (markup: string) =>
      markup.match(/<div class="(absolute bottom-5 z-10[^"]*)">/)?.[1] ?? null;

    expect(floating(render(deployed, { layout: "default", mode: "default" }))).toContain("right-5");
    expect(floating(render(deployed, { layout: "mirrored", mode: "default" }))).toContain("left-5");
    // Expanded keeps them in flow under the divider, at every width.
    expect(floating(render(deployed, { layout: "default", mode: "expanded" }))).toBeNull();
    expect(render(deployed, { layout: "default", mode: "expanded" })).not.toContain(
      "border-border-subtle pt-4 lg:hidden"
    );
    // The default's in-flow row is the below-lg fallback for the floated group.
    expect(render(deployed, { layout: "default", mode: "default" })).toContain(
      "border-border-subtle pt-4 lg:hidden"
    );
  });

  it("spells the status out in expanded and rides it on the address by default", () => {
    const expanded = (tokenInput: Token) =>
      render(tokenInput, { layout: "default", mode: "expanded" });
    const defaultMode = (tokenInput: Token) =>
      render(tokenInput, { layout: "default", mode: "default" });

    // Expanded: status · address · token id.
    expect(expanded(deployed)).toContain("Active");
    expect(separators(expanded(deployed))).toBe(2);
    expect(expanded(token)).toContain("Draft");
    expect(separators(expanded(token))).toBe(1);

    // Default: the live states become the address glyph, so the segment goes.
    for (const [status, colour, icon] of [
      ["active", "text-success", "lucide-globe"],
      ["paused", "text-warning", "lucide-pause"],
    ] as const) {
      const markup = defaultMode({ ...deployed, status });
      expect(separators(markup), `${status} separators`).toBe(1);
      expect(markup, `${status} colour`).toContain(colour);
      expect(markup, `${status} icon`).toContain(icon);
      // One glyph ahead of the address, never two.
      expect(markup.match(/lucide-globe|lucide-pause/g), `${status} glyphs`).toHaveLength(1);
      expect(markup, `${status} label`).toContain(status === "active" ? "Active" : "Paused");
    }

    // A draft leaves the default header entirely: no dot, no label, nothing to
    // separate from the token id. Revoked still says so in words.
    expect(defaultMode(token)).not.toContain("Draft");
    expect(separators(defaultMode(token))).toBe(0);
    expect(defaultMode({ ...deployed, status: "revoked" })).toContain("Revoked");
    expect(separators(defaultMode({ ...deployed, status: "revoked" }))).toBe(2);
  });

  it("never prints a placeholder for a missing address", () => {
    for (const appearance of APPEARANCES) {
      expect(render(token, appearance), `${appearance.mode}`).not.toContain("Not deployed");
    }
    expect(render(deployed, HEADER_APPEARANCE_DEFAULTS)).toContain("58NU6…VjVu");
  });

  it("steps the mark down to a quiet placeholder when the asset has no logo", () => {
    const markup = render(token);
    // Two stand-ins in the default mode — the stepped-down mark and the
    // narrow-screen avatar. The mark keeps the inset padding; the avatar drops it.
    const marks = [...markup.matchAll(/<div class="([^"]*bg-fill-subtle[^"]*)">([^<]*)<\/div>/g)];
    const mark = marks.find(([, classes = ""]) => classes.includes("px-3"));
    expect(mark, "stepped-down letter mark").toBeDefined();
    const [, markClasses = "", label = ""] = mark ?? [];

    // The whole symbol, at the issuer's own casing and sized to fit — a prefix of
    // a longer ticker would read as truncated rather than as a mark.
    expect(label).toBe(token.symbol);
    expect(markClasses).toContain("text-xs");
    expect(markClasses).not.toContain("uppercase");
    // It stands in for artwork, so it is a tinted placeholder rather than the
    // full-contrast block a hero mark would be.
    expect(markClasses).toContain("text-tertiary");
    expect(markup).not.toContain("bg-primary");

    // And it is the small mark, not the hero bleed: no full-size box, and the
    // ticker beside it moves in to the stepped-down inset.
    expect(markup).not.toContain("-left-10");
    expect(markup).toContain("left-[132px]");

    // The avatar carries a monogram instead — a symbol at 56px would be illegible.
    const avatarMark = marks.find(([, classes = ""]) => classes.includes("px-0"));
    expect(avatarMark?.[2], "avatar monogram").toBe("t");

    // A logo replaces the letters entirely.
    expect(render(deployed)).not.toMatch(/<div class="[^"]*px-3[^"]*">[^<]/);
  });

  it("swaps the mark for a small avatar below lg only when the content centres over it", () => {
    const avatar = (mode: HeaderAppearance["mode"]) =>
      render(deployed, { mode }).match(/<div aria-hidden="true" class="(mx-auto[^"]*)"/)?.[1] ??
      null;

    // The default centres the content over the mark, so the narrow layout keeps
    // it as a small round avatar in flow. Expanded has none to keep down there.
    const defaultModeAvatar = avatar("default") ?? "";
    expect(defaultModeAvatar).toContain("h-14 w-14");
    expect(defaultModeAvatar).toContain("rounded-full");
    expect(defaultModeAvatar).toContain("lg:hidden");
    expect(avatar("expanded")).toBeNull();

    // The bleeding mark is an lg-and-up treatment either way, and never fades.
    for (const appearance of APPEARANCES) {
      const markup = render(deployed, appearance);
      expect(markup, `${appearance.mode} bleed`).toMatch(/hidden -translate-y-1\/2 lg:block/);
      expect(markup, `${appearance.mode} opacity`).not.toContain("opacity-1");
    }
  });

  it("stacks the below-lg ticker under the name, with nothing to sit beside", () => {
    for (const mode of ["default", "expanded"] as const) {
      const markup = render(deployed, { mode });
      expect(markup.indexOf('<div class="lg:hidden">'), `${mode} under the name`).toBeGreaterThan(
        markup.indexOf(deployed.name)
      );
      // One below-lg ticker and one positioned against the desktop mark, no more.
      expect(markup.match(/<span class="sr-only">Ticker/g), `${mode} count`).toHaveLength(2);
    }
  });

  it("sizes the ticker to the mark it sits beside", () => {
    const tickerType = (tokenInput: Token) =>
      render(tokenInput).match(/<p class="([^"]*)"><span class="sr-only">Ticker/)?.[1] ?? "";

    // The hero bleed carries the large symbol; a stepped-down mark (here, no
    // artwork at all) pulls it down so the symbol never outweighs the mark.
    expect(tickerType(deployed), "hero").toContain("text-lg");
    expect(tickerType(token), "stepped down").toContain("text-sm");
  });

  it("gives the ticker the exchange face and never recases the symbol", () => {
    const ticker = render(deployed).match(
      /<p class="([^"]*)"><span class="sr-only">Ticker<\/span>([^<]*)<\/p>/
    );
    expect(ticker, "ticker element").not.toBeNull();
    const [, tickerClasses = "", renderedSymbol = ""] = ticker ?? [];

    expect(tickerClasses).toContain("var(--font-ticker-archivo)");
    // The only weight loaded for that family is 600; anything else is synthesised.
    expect(tickerClasses).toContain("font-semibold");
    expect(tickerClasses).toContain("tracking-[0.06em]");
    expect(renderedSymbol).toBe(deployed.symbol);
    expect(tickerClasses).not.toContain("uppercase");
    expect(tickerClasses).not.toContain("capitalize");
  });
});
