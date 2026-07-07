import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { createInitialDraft } from "./issuance-draft-wizard.types";
import { PublicInfoPreview } from "./public-info-preview";

describe("PublicInfoPreview", () => {
  it("renders public-field toggles as disabled while saving", () => {
    const draft = createInitialDraft();
    draft.assetCategory = "stablecoin";
    draft.assetType = "fiat_backed";
    draft.issuerName = "Example issuer";
    draft.pegCurrency = "USD";

    const markup = renderToStaticMarkup(
      <PublicInfoPreview draft={draft} onToggleField={() => undefined} disabled />
    );

    expect(markup).toContain("aria-disabled");
  });
});
