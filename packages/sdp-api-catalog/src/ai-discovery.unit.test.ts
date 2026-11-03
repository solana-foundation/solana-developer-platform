import { describe, expect, it } from "vitest";
import { apiDiscoveryFamilies, renderLlmsTxt } from "./ai-discovery";

const document = {
  paths: {
    "/health": { get: { tags: ["Health"] } },
    "/v1/wallets": { get: { tags: ["Wallets"] }, post: { tags: ["Wallets"] } },
    "/v1/wallets/{walletId}": { get: { tags: ["Wallets"] } },
  },
  tags: [{ name: "Health" }, { name: "Wallets" }, { name: "Unpublished" }],
};

function familySection(body: string): string {
  const sections = body.split("## Public endpoint families\n");
  expect(sections).toHaveLength(2);
  const section = sections[1];
  if (section === undefined) throw new Error("Missing public endpoint families section");
  return section.split("\n\n")[0];
}

describe("llms.txt generation", () => {
  it("lists the same published families in docs and API output", () => {
    const api = renderLlmsTxt({ audience: "api", document });
    const docs = renderLlmsTxt({
      audience: "docs",
      document,
      supportedSurfaces: ["Wallets and custody"],
      startHere: [],
    });

    expect(familySection(docs)).toBe(familySection(api));
    expect(familySection(api)).toBe(
      "- Health: https://api.solana.com/health\n- Wallets: https://api.solana.com/v1/wallets"
    );
    expect(api).not.toContain("Unpublished");
    expect(docs).not.toContain("Unpublished");
  });

  it("fails when a public operation has no family tag", () => {
    expect(() => apiDiscoveryFamilies({ paths: { "/v1/wallets": { get: {} } }, tags: [] })).toThrow(
      "GET /v1/wallets has no API family tag"
    );
  });
});
