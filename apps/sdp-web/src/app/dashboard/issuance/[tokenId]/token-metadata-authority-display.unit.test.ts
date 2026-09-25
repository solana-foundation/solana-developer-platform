import type { Token } from "@sdp/types";
import { describe, expect, it } from "vitest";
import { getMessages, type MessageKey, type TranslationValues, translate } from "@/i18n/messages";
import { getPermissionRows, getTokenMetadataAuthority } from "./token-management-workspace.utils";

const MINT_AUTHORITY = "8dHEsGLpCZHZbXnFVvqWq4kMfM2pVDuNrXvVJVhQWRGZ";
const METADATA_AUTHORITY = "7iQJKBEwzBccKMvyZgnPmXfSPJB5XjN7hE2vgGYX5Kkv";

function token(overrides: Partial<Token> = {}): Token {
  return {
    id: "tok_metadata_display",
    projectId: "prj_metadata_display",
    organizationId: "org_metadata_display",
    signingCustodyWalletId: null,
    signingWalletId: null,
    mintAddress: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
    mintAuthority: MINT_AUTHORITY,
    metadataAuthority: METADATA_AUTHORITY,
    freezeAuthority: null,
    ablListAddress: null,
    name: "Display Token",
    symbol: "DSP",
    decimals: 6,
    description: null,
    uri: null,
    imageUrl: null,
    template: "custom",
    extensions: null,
    totalSupply: "0",
    totalSupplyUpdatedAt: "2026-09-01T00:00:00.000Z",
    maxSupply: null,
    isMintable: true,
    isFreezable: false,
    requiresAllowlist: false,
    status: "active",
    deployedAt: "2026-09-01T00:00:00.000Z",
    createdBy: "key_metadata_display",
    createdAt: "2026-09-01T00:00:00.000Z",
    updatedAt: "2026-09-01T00:00:00.000Z",
    ...overrides,
  };
}

describe("getTokenMetadataAuthority", () => {
  it("returns the stored metadata authority when set", () => {
    expect(getTokenMetadataAuthority(token())).toBe(METADATA_AUTHORITY);
  });

  it("does not reconstruct a revoked metadata authority from the mint authority", () => {
    expect(
      getTokenMetadataAuthority(token({ metadataAuthority: null, metadataAuthorityRevoked: true }))
    ).toBeNull();
  });

  it("keeps the mint fallback for legacy rows that never stored a metadata authority", () => {
    expect(
      getTokenMetadataAuthority(token({ metadataAuthority: null, metadataAuthorityRevoked: false }))
    ).toBe(MINT_AUTHORITY);
  });

  it("prefers the stored authority over the mint fallback when both exist", () => {
    expect(getTokenMetadataAuthority(token({ metadataAuthorityRevoked: false }))).toBe(
      METADATA_AUTHORITY
    );
  });
});

describe("metadata permission row display", () => {
  const messages = getMessages("en");
  const t = (key: MessageKey, values?: TranslationValues) => translate(messages, key, values);

  it("reports the revoked metadata authority as unset instead of the mint authority", () => {
    const rows = getPermissionRows(
      token({ metadataAuthority: null, metadataAuthorityRevoked: true }),
      getTokenMetadataAuthority(token({ metadataAuthority: null, metadataAuthorityRevoked: true })),
      t
    );
    const metadataRow = rows.find((row) => row.id === "metadata-authority");
    expect(metadataRow?.value).toBeNull();
    expect(metadataRow?.value).not.toBe(MINT_AUTHORITY);
  });
});
