import type { AssetProfile, IssuanceMetadata, Token } from "@sdp/types";
import { describe, expect, it } from "vitest";
import { buildIssuanceMetadata } from "../../create/draft-mapping";
import {
  areDraftsEquivalent,
  mergeIssuanceMetadataForUpdate,
  profileToDraftState,
} from "./asset-profile-mapping";

function makeToken(overrides: Partial<Token> = {}): Token {
  return {
    id: "tok_test",
    projectId: "prj_test",
    organizationId: "org_test",
    signingWalletId: "wal_test",
    mintAddress: null,
    mintAuthority: null,
    metadataAuthority: null,
    freezeAuthority: null,
    ablListAddress: null,
    name: "Verde Dollar",
    symbol: "VUSD",
    decimals: 6,
    description: "A test stablecoin",
    uri: "https://example.com/metadata.json",
    imageUrl: "https://example.com/logo.png",
    template: "stablecoin",
    extensions: null,
    totalSupply: "0",
    maxSupply: null,
    isMintable: true,
    isFreezable: true,
    requiresAllowlist: false,
    status: "pending",
    deployedAt: null,
    createdBy: "user_test",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

function makeProfile(
  metadata: IssuanceMetadata,
  overrides: Partial<AssetProfile> = {}
): AssetProfile {
  return {
    id: "asset_profile_test",
    organizationId: "org_test",
    projectId: "prj_test",
    tokenId: "tok_test",
    assetCategory: "stablecoin",
    assetType: "fiat_backed",
    assetTypeVersion: 1,
    issuanceMetadata: metadata,
    publicMetadata: {},
    status: "active",
    createdBy: "user_test",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

// A profile carrying everything the form does NOT know about: integration
// custom data, an unknown top-level namespace, chain enrichment, an unknown
// key inside asset, and a non-string customer value.
const FOREIGN_METADATA: IssuanceMetadata = {
  asset: {
    name: "Verde Dollar",
    description: "A test stablecoin",
    website: "https://verde.example",
    issuerName: "Verde Inc",
    pegCurrency: "USD",
    externalRef: "ext-123",
    documents: [{ type: "prospectus", name: "Prospectus", url: "https://verde.example/doc.pdf" }],
  },
  compliance: {
    accessControl: "blocklist",
    capacities: { kyc: { enabled: true } },
    reviewerNotes: "integration-written",
  },
  chain: {
    decimals: 6,
    mintAddress: "MintAddr1111111111111111111111111111111111",
  },
  custom: {
    customer: { department: "treasury", config: { nested: true } },
    integration: { manifest: { version: 2 } },
  },
  sstsManifest: { modules: ["a", "b"] },
};

describe("profileToDraftState", () => {
  it("hydrates form fields from metadata with token-row precedence", () => {
    const token = makeToken({ name: "Renamed On Token", description: "Token-side description" });
    const draft = profileToDraftState(makeProfile(FOREIGN_METADATA), token);

    // Token row wins for duplicated fields.
    expect(draft.name).toBe("Renamed On Token");
    expect(draft.symbol).toBe("VUSD");
    expect(draft.decimals).toBe("6");
    expect(draft.description).toBe("Token-side description");
    expect(draft.imageUrl).toBe("https://example.com/logo.png");
    expect(draft.metadataUri).toBe("https://example.com/metadata.json");
    expect(draft.signingWalletId).toBe("wal_test");

    // Profile-only fields come from the metadata.
    expect(draft.assetCategory).toBe("stablecoin");
    expect(draft.assetType).toBe("fiat_backed");
    expect(draft.website).toBe("https://verde.example");
    expect(draft.issuerName).toBe("Verde Inc");
    expect(draft.pegCurrency).toBe("USD");
    expect(draft.accessControl).toBe("blocklist");
    expect(draft.capacities.kyc.enabled).toBe(true);
    expect(draft.capacities.transferApprovals.enabled).toBe(false);

    expect(draft.documents).toHaveLength(1);
    expect(draft.documents[0]).toMatchObject({
      docType: "prospectus",
      name: "Prospectus",
      url: "https://verde.example/doc.pdf",
    });

    // Only string-valued customer entries become editable rows.
    expect(draft.customFields).toHaveLength(1);
    expect(draft.customFields[0]).toMatchObject({ key: "department", value: "treasury" });
  });

  it("handles a profile with empty metadata", () => {
    const draft = profileToDraftState(makeProfile({}), makeToken({ description: null }));
    expect(draft.website).toBe("");
    expect(draft.description).toBe("");
    expect(draft.documents).toEqual([]);
    expect(draft.customFields).toEqual([]);
    expect(draft.accessControl).toBe("");
  });

  it("falls back to the registry default public fields when visibility is absent", () => {
    const draft = profileToDraftState(makeProfile(FOREIGN_METADATA), makeToken());
    expect(draft.publicFields).toEqual([
      "asset.name",
      "asset.issuerName",
      "asset.pegCurrency",
      "chain.decimals",
      "asset.website",
    ]);
  });

  it("hydrates the stored public-field selection when present", () => {
    const draft = profileToDraftState(
      makeProfile({ ...FOREIGN_METADATA, visibility: { public: ["asset.name", "asset.website"] } }),
      makeToken()
    );
    expect(draft.publicFields).toEqual(["asset.name", "asset.website"]);
  });

  it("back-compat: hydrates a legacy bare-boolean capacity map", () => {
    // Pre-config-layer drafts stored capacities as { key: true }. They must still
    // read as enabled (no crash), with no config attached.
    const legacy: IssuanceMetadata = {
      ...FOREIGN_METADATA,
      compliance: { capacities: { kyc: true, transferApprovals: true } },
    };
    const draft = profileToDraftState(makeProfile(legacy), makeToken());
    expect(draft.capacities.kyc).toEqual({ enabled: true });
    expect(draft.capacities.transferApprovals).toEqual({ enabled: true });
    expect(draft.capacities.investorReporting.enabled).toBe(false);
  });

  it("hydrates per-policy config from the object encoding", () => {
    const withConfig: IssuanceMetadata = {
      ...FOREIGN_METADATA,
      compliance: {
        capacities: {
          transferApprovals: { enabled: true, config: { rule: "above_amount", amount: "10000" } },
        },
      },
    };
    const draft = profileToDraftState(makeProfile(withConfig), makeToken());
    expect(draft.capacities.transferApprovals).toEqual({
      enabled: true,
      config: { rule: "above_amount", amount: "10000" },
    });
  });
});

describe("mergeIssuanceMetadataForUpdate", () => {
  it("load-then-save without edits changes nothing", () => {
    const token = makeToken();
    const profile = makeProfile(FOREIGN_METADATA);
    const draft = profileToDraftState(profile, token);
    const merged = mergeIssuanceMetadataForUpdate(
      profile.issuanceMetadata,
      buildIssuanceMetadata(draft)
    );

    expect(merged).toEqual(FOREIGN_METADATA);
  });

  it("upgrades a legacy bare-boolean capacity map to the object encoding on save", () => {
    const token = makeToken();
    const legacy: IssuanceMetadata = {
      ...FOREIGN_METADATA,
      compliance: {
        accessControl: "blocklist",
        capacities: { kyc: true },
        reviewerNotes: "integration-written",
      },
    };
    const profile = makeProfile(legacy);
    const draft = profileToDraftState(profile, token);
    const merged = mergeIssuanceMetadataForUpdate(
      profile.issuanceMetadata,
      buildIssuanceMetadata(draft)
    );

    // The owned capacities key is re-emitted in the new encoding...
    expect((merged.compliance as Record<string, unknown>).capacities).toEqual({
      kyc: { enabled: true },
    });
    // ...while foreign compliance data is carried through untouched.
    expect(merged.compliance).toMatchObject({ reviewerNotes: "integration-written" });
  });

  it("preserves foreign data when owned fields change", () => {
    const token = makeToken();
    const profile = makeProfile(FOREIGN_METADATA);
    const draft = { ...profileToDraftState(profile, token), issuerName: "New Issuer Corp" };
    const merged = mergeIssuanceMetadataForUpdate(
      profile.issuanceMetadata,
      buildIssuanceMetadata(draft)
    );

    expect(merged.asset).toMatchObject({ issuerName: "New Issuer Corp", externalRef: "ext-123" });
    expect(merged.compliance).toMatchObject({ reviewerNotes: "integration-written" });
    expect(merged.chain).toMatchObject({
      mintAddress: "MintAddr1111111111111111111111111111111111",
    });
    expect(merged.custom).toEqual({
      customer: { department: "treasury", config: { nested: true } },
      integration: { manifest: { version: 2 } },
    });
    expect(merged.sstsManifest).toEqual({ modules: ["a", "b"] });
  });

  it("deletes an owned key when the user clears the field", () => {
    const token = makeToken();
    const profile = makeProfile(FOREIGN_METADATA);
    const draft = { ...profileToDraftState(profile, token), website: "" };
    const merged = mergeIssuanceMetadataForUpdate(
      profile.issuanceMetadata,
      buildIssuanceMetadata(draft)
    );

    expect(merged.asset).not.toHaveProperty("website");
    expect(merged.asset).toMatchObject({ externalRef: "ext-123" });
  });

  it("replaces string customer entries but keeps non-string ones", () => {
    const token = makeToken();
    const profile = makeProfile(FOREIGN_METADATA);
    const base = profileToDraftState(profile, token);
    const draft = {
      ...base,
      customFields: [{ id: "row-1", key: "region", value: "emea" }],
    };
    const merged = mergeIssuanceMetadataForUpdate(
      profile.issuanceMetadata,
      buildIssuanceMetadata(draft)
    );

    const customer = (merged.custom as { customer: Record<string, unknown> }).customer;
    expect(customer).toEqual({ region: "emea", config: { nested: true } });
  });

  it("persists a customized public-field selection", () => {
    const token = makeToken();
    const profile = makeProfile(FOREIGN_METADATA);
    // Turn issuerName off relative to the fiat_backed default.
    const draft = {
      ...profileToDraftState(profile, token),
      publicFields: ["asset.name", "asset.pegCurrency", "chain.decimals"],
    };
    const merged = mergeIssuanceMetadataForUpdate(
      profile.issuanceMetadata,
      buildIssuanceMetadata(draft)
    );

    expect(merged.visibility).toEqual({
      public: ["asset.name", "asset.pegCurrency", "chain.decimals"],
    });
    // Foreign data still survives.
    expect(merged.sstsManifest).toEqual({ modules: ["a", "b"] });
  });

  it("clears a stored selection when the user reverts to the default", () => {
    const token = makeToken();
    const profile = makeProfile({ ...FOREIGN_METADATA, visibility: { public: ["asset.name"] } });
    // Default selection ⇒ buildIssuanceMetadata omits visibility ⇒ merge drops it.
    const draft = profileToDraftState(makeProfile(FOREIGN_METADATA), token);
    const merged = mergeIssuanceMetadataForUpdate(
      profile.issuanceMetadata,
      buildIssuanceMetadata(draft)
    );

    expect(merged).not.toHaveProperty("visibility");
  });
});

describe("areDraftsEquivalent", () => {
  it("ignores row-id churn, whitespace, and empty rows", () => {
    const token = makeToken();
    const profile = makeProfile(FOREIGN_METADATA);
    const a = profileToDraftState(profile, token);
    const b = {
      ...profileToDraftState(profile, token),
      name: `  ${a.name}  `,
      documents: [...a.documents.map((doc) => ({ ...doc, id: "different-id" }))],
      customFields: [
        ...a.customFields.map((field) => ({ ...field, id: "other-id" })),
        { id: "empty", key: "", value: "" },
      ],
    };

    expect(areDraftsEquivalent(a, b)).toBe(true);
  });

  it("ignores a type-only document row that can never be persisted", () => {
    const token = makeToken();
    const profile = makeProfile(FOREIGN_METADATA);
    const a = profileToDraftState(profile, token);
    // A row with only a type selected is dropped by buildIssuanceMetadata and by
    // hydration, so it must not mark the form dirty (would strand it "unsaved").
    const withTypeOnlyRow = {
      ...a,
      documents: [...a.documents, { id: "type-only", docType: "prospectus", name: "", url: "" }],
    };

    expect(areDraftsEquivalent(a, withTypeOnlyRow)).toBe(true);
  });

  it("detects a real change", () => {
    const token = makeToken();
    const profile = makeProfile(FOREIGN_METADATA);
    const a = profileToDraftState(profile, token);
    const b = { ...profileToDraftState(profile, token), issuerName: "Changed" };

    expect(areDraftsEquivalent(a, b)).toBe(false);
  });

  it("detects a public-field visibility change but ignores its order", () => {
    const token = makeToken();
    const profile = makeProfile(FOREIGN_METADATA);
    const a = profileToDraftState(profile, token);
    const reordered = { ...a, publicFields: [...a.publicFields].reverse() };
    const toggledOff = {
      ...a,
      publicFields: a.publicFields.filter((path) => path !== "asset.issuerName"),
    };

    expect(areDraftsEquivalent(a, reordered)).toBe(true);
    expect(areDraftsEquivalent(a, toggledOff)).toBe(false);
  });
});
