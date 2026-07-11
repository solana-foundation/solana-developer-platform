import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { getMessages } from "@/i18n/messages";
import { I18nProvider } from "@/i18n/provider";
import { createInitialDraft } from "./issuance-draft-wizard.types";
import { PublicInfoPreview } from "./public-info-preview";

function stablecoinDraft() {
  const draft = createInitialDraft();
  draft.assetCategory = "stablecoin";
  draft.assetType = "fiat_backed";
  draft.issuerName = "Example issuer";
  draft.pegCurrency = "USD";
  return draft;
}

function renderWithI18n(children: ReactNode) {
  return renderToStaticMarkup(
    <I18nProvider locale="en" messages={getMessages("en")}>
      {children}
    </I18nProvider>
  );
}

describe("PublicInfoPreview", () => {
  it("renders public-field toggles as disabled while saving", () => {
    const markup = renderWithI18n(
      <PublicInfoPreview draft={stablecoinDraft()} onToggleField={() => undefined} disabled />
    );

    expect(markup).toContain("aria-disabled");
  });

  it("summarizes public-field coverage", () => {
    const markup = renderWithI18n(
      <PublicInfoPreview draft={stablecoinDraft()} onToggleField={() => undefined} />
    );

    expect(markup).toContain("fields public");
    expect(markup).toContain("public");
  });

  it("makes each toggleable field row a full-width button", () => {
    const markup = renderWithI18n(
      <PublicInfoPreview draft={stablecoinDraft()} onToggleField={() => undefined} />
    );

    // The whole row is the click target, not just the round check.
    expect(markup).toMatch(/<button[^>]*w-full items-start/);
  });

  it("hides the mint address until the token is deployed", () => {
    const markup = renderWithI18n(
      <PublicInfoPreview draft={stablecoinDraft()} onToggleField={() => undefined} />
    );

    // Default surface is the token page; without a mint address its footer is omitted.
    expect(markup).not.toContain("Mint address");
  });

  it("shows the truncated mint address once deployed", () => {
    const markup = renderWithI18n(
      <PublicInfoPreview
        draft={stablecoinDraft()}
        onToggleField={() => undefined}
        mintAddress="MintAddr1111111111111111111111111111111111"
        explorerHref="https://explorer.solana.com/address/MintAddr1111111111111111111111111111111111"
      />
    );

    expect(markup).toContain("Mint address");
    expect(markup).toContain("MintA…1111");
  });
});
