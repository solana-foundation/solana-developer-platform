import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
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

describe("PublicInfoPreview", () => {
  it("renders public-field toggles as disabled while saving", () => {
    const markup = renderToStaticMarkup(
      <PublicInfoPreview draft={stablecoinDraft()} onToggleField={() => undefined} disabled />
    );

    expect(markup).toContain("aria-disabled");
  });

  it("summarizes public-field coverage", () => {
    const markup = renderToStaticMarkup(
      <PublicInfoPreview draft={stablecoinDraft()} onToggleField={() => undefined} />
    );

    expect(markup).toContain("fields public");
    expect(markup).toContain("public");
  });

  it("hides the mint address until the token is deployed", () => {
    const markup = renderToStaticMarkup(
      <PublicInfoPreview draft={stablecoinDraft()} onToggleField={() => undefined} />
    );

    // Default surface is the token page; without a mint address its footer is omitted.
    expect(markup).not.toContain("Mint address");
  });

  it("shows the truncated mint address once deployed", () => {
    const markup = renderToStaticMarkup(
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
