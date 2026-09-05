import { describe, expect, it } from "vitest";
import { issuanceMetadataSchema } from "./schemas";

// HOO-1013: link-bearing keys in the open `asset` namespace end up on the
// public metadata.json (asset.website sits on most registry projections), so
// active-content schemes must fail validation while ordinary free-form fields
// stay unconstrained.
describe("issuanceMetadataSchema asset link validation", () => {
  it("accepts http(s) links and free-form non-link fields", () => {
    const result = issuanceMetadataSchema.safeParse({
      asset: {
        name: "Acme Fund",
        description: "Contains a colon: like this, and ISIN:US0000000001",
        website: "https://acme.example",
        logoUrl: "http://cdn.acme.example/logo.png",
      },
    });
    expect(result.success).toBe(true);
  });

  it("rejects active-content schemes in asset.website", () => {
    for (const website of [
      "javascript:alert(1)",
      "data:text/html;base64,PGh0bWw+",
      "file:///etc/passwd",
    ]) {
      const result = issuanceMetadataSchema.safeParse({ asset: { website } });
      expect(result.success, website).toBe(false);
    }
  });

  it("rejects hostile schemes in any link-suffixed key", () => {
    for (const asset of [
      { docsUrl: "javascript:alert(1)" },
      { externalLink: "data:text/plain,x" },
      { icon: "file:///icon.png" },
      { homepage: "vbscript:evil" },
    ]) {
      const result = issuanceMetadataSchema.safeParse({ asset });
      expect(result.success, JSON.stringify(asset)).toBe(false);
    }
  });

  it("rejects non-string and oversized link values", () => {
    expect(issuanceMetadataSchema.safeParse({ asset: { website: 42 } }).success).toBe(false);
    expect(
      issuanceMetadataSchema.safeParse({
        asset: { website: `https://a.example/${"x".repeat(2048)}` },
      }).success
    ).toBe(false);
  });

  it("does not constrain link-shaped text in non-link keys", () => {
    const result = issuanceMetadataSchema.safeParse({
      asset: { notes: "javascript:alert(1) quoted in an incident report" },
      compliance: { website: "javascript:not-validated-here" },
    });
    // compliance.* is never publicly projected; only the asset namespace is
    // clamped. The schema stays permissive elsewhere by design.
    expect(result.success).toBe(true);
  });
});
