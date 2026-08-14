import type { PaymentWalletPolicy } from "@sdp/types";
import { describe, expect, it } from "vitest";
import {
  buildDisabledPolicyPayload,
  buildPolicyAssetOptions,
  buildPolicyPayload,
  createPolicyAuthoringState,
  hasLimitsAndAssetsControls,
  loadPolicyDraft,
  parseDestinationText,
  policyDraftStorageKey,
  type StoredPolicyDraft,
  savePolicyDraft,
  validatePolicyState,
  WALLET_OPERATION_FAMILIES,
} from "./wallet-policy-authoring";

const WALLET_ID = "wallet_test";
const PROJECT_ID = "project_test";
const ADDRESS_A = "11111111111111111111111111111111";
const ADDRESS_B = "So11111111111111111111111111111111111111112";

class MemoryStorage {
  private readonly values = new Map<string, string>();

  getItem(key: string) {
    return this.values.get(key) ?? null;
  }

  setItem(key: string, value: string) {
    this.values.set(key, value);
  }

  removeItem(key: string) {
    this.values.delete(key);
  }
}

function emptyPolicy(): PaymentWalletPolicy {
  return { walletId: WALLET_ID, defaultAction: "allow", rules: [], controlProfile: null };
}

describe("wallet policy authoring", () => {
  it("offers only operation families with active enforcement call sites", () => {
    expect(WALLET_OPERATION_FAMILIES).toEqual(["payment", "ramp", "issuance"]);
  });

  it("identifies whether the limits and assets step has selected controls", () => {
    const state = createPolicyAuthoringState(emptyPolicy());
    expect(hasLimitsAndAssetsControls(state)).toBe(false);

    state.categories = ["limits"];
    expect(hasLimitsAndAssetsControls(state)).toBe(true);

    state.categories = ["assets"];
    expect(hasLimitsAndAssetsControls(state)).toBe(true);
  });

  it("validates limit rows in asset, duplicate, then decimal priority order", () => {
    const state = createPolicyAuthoringState(emptyPolicy());
    expect(validatePolicyState(state).intent).toBe("restriction_required");

    state.categories = ["limits"];
    state.limits = [
      { asset: "not-a-mint", max: "1.2.3" },
      { asset: "not-a-mint", max: "100" },
    ];
    expect(validatePolicyState(state).limits).toBe("invalid_asset");

    state.limits = [
      { asset: ADDRESS_A, max: "100" },
      { asset: ADDRESS_A, max: "1.2.3" },
    ];
    expect(validatePolicyState(state).limits).toBe("duplicate_asset");

    state.limits = [{ asset: ADDRESS_A, max: "1.2.3" }];
    expect(validatePolicyState(state).limits).toBe("invalid_decimal");

    state.limits = [{ asset: ADDRESS_A, max: "0.5" }];
    expect(validatePolicyState(state).limits).toBeUndefined();

    state.categories = [];
    state.limits = [{ asset: "not-a-mint", max: "1.2.3" }];
    expect(validatePolicyState(state).limits).toBeUndefined();
  });

  it("parses comma-separated destinations, de-duplicates, and reports invalid entries", () => {
    const parsed = parseDestinationText(`  ${ADDRESS_B}, ${ADDRESS_A}, ${ADDRESS_B}, not-a-wallet`);

    expect(parsed.valid).toEqual([ADDRESS_B, ADDRESS_A]);
    expect(parsed.entries[2]).toMatchObject({
      value: ADDRESS_B,
      duplicate: true,
      position: 3,
    });
    expect(parsed.invalid).toEqual([
      expect.objectContaining({ value: "not-a-wallet", position: 4, valid: false }),
    ]);
  });

  it("accepts pasted newline-separated destination lists", () => {
    expect(parseDestinationText(`${ADDRESS_A}\n${ADDRESS_B}`).valid).toEqual([
      ADDRESS_A,
      ADDRESS_B,
    ]);
  });

  it("persists a project- and wallet-scoped local draft", () => {
    const storage = new MemoryStorage();
    const state = createPolicyAuthoringState(emptyPolicy());
    state.defaultAction = "deny";
    const draft: StoredPolicyDraft = {
      version: 1,
      projectId: PROJECT_ID,
      walletId: WALLET_ID,
      step: "limits-assets",
      state,
      updatedAt: "2026-07-15T20:00:00.000Z",
    };

    savePolicyDraft(storage, draft);

    expect(policyDraftStorageKey(PROJECT_ID, WALLET_ID)).toContain(`${PROJECT_ID}.${WALLET_ID}`);
    expect(loadPolicyDraft(storage, PROJECT_ID, WALLET_ID)).toEqual(draft);
    expect(loadPolicyDraft(storage, "another-project", WALLET_ID)).toBeNull();
  });

  it("drops a retired maxDailyAmount field from a draft saved by an older build", () => {
    const storage = new MemoryStorage();
    const state = createPolicyAuthoringState(emptyPolicy());
    state.categories = ["limits"];
    state.limits = [{ asset: ADDRESS_A, max: "100" }];
    const legacyDraft = {
      version: 1,
      projectId: PROJECT_ID,
      walletId: WALLET_ID,
      step: "limits-assets",
      state: { ...state, maxDailyAmount: "500" },
      updatedAt: "2026-07-15T20:00:00.000Z",
    };
    storage.setItem(policyDraftStorageKey(PROJECT_ID, WALLET_ID), JSON.stringify(legacyDraft));

    const loaded = loadPolicyDraft(storage, PROJECT_ID, WALLET_ID);

    expect(loaded?.state).toEqual(state);
    expect(loaded?.state).not.toHaveProperty("maxDailyAmount");
  });

  it("rejects an old-shape draft carrying maxTransferAmount", () => {
    const storage = new MemoryStorage();
    const state = createPolicyAuthoringState(emptyPolicy());
    const { limits: _limits, ...stateWithoutLimits } = state;
    const legacyDraft = {
      version: 1,
      projectId: PROJECT_ID,
      walletId: WALLET_ID,
      step: "limits-assets",
      state: { ...stateWithoutLimits, maxTransferAmount: "100" },
      updatedAt: "2026-07-15T20:00:00.000Z",
    };
    const key = policyDraftStorageKey(PROJECT_ID, WALLET_ID);
    storage.setItem(key, JSON.stringify(legacyDraft));

    expect(loadPolicyDraft(storage, PROJECT_ID, WALLET_ID)).toBeNull();
    expect(storage.getItem(key)).toBeNull();
  });

  it("filters erased rules out of a stale draft's passthrough", () => {
    const storage = new MemoryStorage();
    const liveRule: PaymentWalletPolicy["rules"][number] = {
      id: "bounded",
      kind: "amount",
      asset: ADDRESS_A,
      min: "1",
      max: "100",
    };
    const state = createPolicyAuthoringState(emptyPolicy());
    state.passthroughRules = [
      { id: "dead-families", kind: "operation_family", families: ["transfer", "provider_admin"] },
      { id: "dead-approval", kind: "approval", families: ["raw_sign"] },
      { id: "asset-less-cap", kind: "amount", max: "150", action: "allow" },
      liveRule,
    ];
    savePolicyDraft(storage, {
      version: 1,
      projectId: PROJECT_ID,
      walletId: WALLET_ID,
      step: "review",
      state,
      updatedAt: "2026-07-15T20:00:00.000Z",
    });

    expect(loadPolicyDraft(storage, PROJECT_ID, WALLET_ID)?.state.passthroughRules).toEqual([
      liveRule,
    ]);
  });

  it("builds an activation payload for every public authoring capability", () => {
    const state = createPolicyAuthoringState(emptyPolicy());
    state.defaultAction = "approval_required";
    state.categories = ["limits", "assets", "destinations", "operations"];
    state.limits = [{ asset: ADDRESS_A, max: "100" }];
    state.assets = [ADDRESS_A];
    state.destinationMode = "allowlist";
    state.destinationAllowText = ADDRESS_B;
    state.familyActions = { payment: "deny", ramp: "approval_required" };
    state.operationTypeRules = [{ value: "payment.create", action: "approval_required" }];

    const payload = buildPolicyPayload(WALLET_ID, state);

    expect(payload).toMatchObject({
      walletId: WALLET_ID,
      defaultAction: "approval_required",
    });
    expect(payload).not.toHaveProperty("destinationAllowlist");
    expect(payload).not.toHaveProperty("maxTransferAmount");
    expect(payload.rules).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "operation_family",
          families: ["payment"],
          action: "deny",
        }),
        expect.objectContaining({
          kind: "operation_family",
          families: ["ramp"],
          action: "approval_required",
        }),
        expect.objectContaining({
          kind: "operation_type",
          operationTypes: ["payment.create"],
          action: "approval_required",
        }),
        expect.objectContaining({ kind: "asset", assets: [ADDRESS_A], action: "allow" }),
        expect.objectContaining({ kind: "destination", allowlist: [ADDRESS_B] }),
        expect.objectContaining({ kind: "amount", max: "100", asset: ADDRESS_A }),
      ])
    );
  });

  it("builds one single-asset amount rule per configured limit", () => {
    const state = createPolicyAuthoringState(emptyPolicy());
    state.categories = ["limits"];
    state.limits = [
      { asset: ADDRESS_A, max: "100" },
      { asset: ADDRESS_B, max: " 25.5 " },
    ];

    expect(buildPolicyPayload(WALLET_ID, state).rules).toEqual([
      {
        id: `per-transaction-limit-${ADDRESS_A}`,
        kind: "amount",
        asset: ADDRESS_A,
        max: "100",
        action: "allow",
        name: "Per transaction limit",
      },
      {
        id: `per-transaction-limit-${ADDRESS_B}`,
        kind: "amount",
        asset: ADDRESS_B,
        max: "25.5",
        action: "allow",
        name: "Per transaction limit",
      },
    ]);
  });

  it("does not emit amount rules for empty maximums", () => {
    const state = createPolicyAuthoringState(emptyPolicy());
    state.categories = ["limits"];
    state.limits = [
      { asset: ADDRESS_A, max: "" },
      { asset: ADDRESS_B, max: "   " },
    ];

    expect(buildPolicyPayload(WALLET_ID, state).rules).toEqual([]);
  });

  it("flags allow-by-default policies that restrict nothing", () => {
    const state = createPolicyAuthoringState(emptyPolicy());
    state.categories = ["limits"];
    expect(validatePolicyState(state).review).toBe("no_restrictions");

    state.limits = [{ asset: ADDRESS_A, max: "" }];
    expect(validatePolicyState(state).review).toBe("no_restrictions");

    state.limits = [{ asset: ADDRESS_A, max: "100" }];
    expect(validatePolicyState(state).review).toBeUndefined();

    state.limits = [];
    state.defaultAction = "deny";
    expect(validatePolicyState(state).review).toBeUndefined();
  });

  it("keeps allow and block destination lists independent in the payload", () => {
    const state = createPolicyAuthoringState(emptyPolicy());
    state.categories = ["destinations"];
    state.destinationAllowText = ADDRESS_A;
    state.destinationBlockText = ADDRESS_B;

    const payload = buildPolicyPayload(WALLET_ID, state);

    expect(payload.rules).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "destination", allowlist: [ADDRESS_A], action: "allow" }),
        expect.objectContaining({ kind: "destination", blocklist: [ADDRESS_B], action: "deny" }),
      ])
    );

    const roundTripped = createPolicyAuthoringState({ ...payload, controlProfile: null });
    expect(roundTripped.destinationAllowText).toBe(ADDRESS_A);
    expect(roundTripped.destinationBlockText).toBe(ADDRESS_B);
  });

  it("disables controls by returning the wallet to default allow", () => {
    expect(buildDisabledPolicyPayload(WALLET_ID)).toEqual({
      walletId: WALLET_ID,
      defaultAction: "allow",
      rules: [],
    });
  });

  it("loads existing policies into equivalent form state without dropping rule capabilities", () => {
    const existing: PaymentWalletPolicy = {
      walletId: WALLET_ID,
      defaultAction: "review",
      controlProfile: null,
      rules: [
        {
          id: "families",
          kind: "operation_family",
          families: ["payment", "issuance"],
          action: "deny",
        },
        {
          id: "types",
          kind: "operation_type",
          operationTypes: ["payment.create"],
          action: "review",
        },
        { id: "assets", kind: "asset", assets: [ADDRESS_A], action: "allow" },
        { id: "destinations", kind: "destination", blocklist: [ADDRESS_B] },
        {
          id: "per-transaction-limit",
          kind: "amount",
          max: "250",
          assets: [ADDRESS_A],
          action: "allow",
        },
        {
          id: "asset-limit",
          kind: "amount",
          max: "50",
          assets: [ADDRESS_A],
          action: "deny",
        },
        { id: "approvals", kind: "approval", families: ["ramp"] },
        { id: "always-review", kind: "always", action: "review" },
      ],
    };

    const state = createPolicyAuthoringState(existing);
    const rebuilt = buildPolicyPayload(WALLET_ID, state);

    expect(state).toMatchObject({
      defaultAction: "approval_required",
      limits: [{ asset: ADDRESS_A, max: "250" }],
      assets: [ADDRESS_A],
      destinationMode: "blocklist",
      destinationBlockText: ADDRESS_B,
      familyActions: { payment: "deny", ramp: "approval_required", issuance: "deny" },
      operationTypeRules: [{ value: "payment.create", action: "approval_required" }],
    });
    expect(rebuilt.rules).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: `per-transaction-limit-${ADDRESS_A}`,
          kind: "amount",
          max: "250",
          asset: ADDRESS_A,
        }),
        expect.objectContaining({ id: "asset-limit", kind: "amount", assets: [ADDRESS_A] }),
        expect.objectContaining({ id: "always-review", kind: "always", action: "review" }),
        expect.objectContaining({ kind: "destination", blocklist: [ADDRESS_B] }),
        expect.objectContaining({
          kind: "operation_family",
          families: ["ramp"],
          action: "approval_required",
        }),
      ])
    );
  });

  it("expands a grouped legacy amount rule into one limit row per asset", () => {
    const existing: PaymentWalletPolicy = {
      walletId: WALLET_ID,
      defaultAction: "allow",
      controlProfile: null,
      rules: [
        {
          id: "per-transaction-limit",
          kind: "amount",
          max: "250",
          assets: [ADDRESS_A, ADDRESS_B],
          action: "allow",
        },
      ],
    };

    const state = createPolicyAuthoringState(existing);

    expect(state.limits).toEqual([
      { asset: ADDRESS_A, max: "250" },
      { asset: ADDRESS_B, max: "250" },
    ]);
    expect(state.passthroughRules).toEqual([]);
  });

  it("round-trips canonical single-asset amount rules exactly", () => {
    const rules: PaymentWalletPolicy["rules"] = [
      {
        id: `per-transaction-limit-${ADDRESS_A}`,
        kind: "amount",
        asset: ADDRESS_A,
        max: "250",
        action: "allow",
        name: "Per transaction limit",
      },
      {
        id: `per-transaction-limit-${ADDRESS_B}`,
        kind: "amount",
        asset: ADDRESS_B,
        max: "50",
        action: "allow",
        name: "Per transaction limit",
      },
    ];
    const existing: PaymentWalletPolicy = {
      walletId: WALLET_ID,
      defaultAction: "allow",
      controlProfile: null,
      rules,
    };

    expect(buildPolicyPayload(WALLET_ID, createPolicyAuthoringState(existing)).rules).toEqual(
      rules
    );
  });

  it("preserves non-editable amount rules as passthrough", () => {
    const rules: PaymentWalletPolicy["rules"] = [
      { id: "bounded", kind: "amount", asset: ADDRESS_A, min: "1", max: "100" },
      { id: "denied", kind: "amount", asset: ADDRESS_B, max: "50", action: "deny" },
    ];
    const state = createPolicyAuthoringState({
      walletId: WALLET_ID,
      defaultAction: "allow",
      controlProfile: null,
      rules,
    });

    expect(state.limits).toEqual([]);
    expect(state.passthroughRules).toEqual(rules);
  });

  it("drops asset-less amount rules so the policy stays writable", () => {
    const state = createPolicyAuthoringState({
      walletId: WALLET_ID,
      defaultAction: "allow",
      controlProfile: null,
      rules: [
        { id: "cap-1", kind: "amount", max: "1", action: "allow" },
        { id: "scoped", kind: "amount", asset: ADDRESS_A, max: "10", action: "allow" },
      ],
    });

    expect(state.limits).toEqual([{ asset: ADDRESS_A, max: "10" }]);
    expect(state.passthroughRules).toEqual([]);
    expect(state.categories).toContain("limits");
    expect(buildPolicyPayload(WALLET_ID, state).rules).toEqual([
      {
        id: `per-transaction-limit-${ADDRESS_A}`,
        kind: "amount",
        asset: ADDRESS_A,
        max: "10",
        action: "allow",
        name: "Per transaction limit",
      },
    ]);
  });

  it("preserves a whole later rule when any named asset already has an editable limit", () => {
    const overlappingRule: PaymentWalletPolicy["rules"][number] = {
      id: "overlapping",
      kind: "amount",
      assets: [ADDRESS_A, ADDRESS_B],
      max: "50",
      action: "allow",
    };
    const state = createPolicyAuthoringState({
      walletId: WALLET_ID,
      defaultAction: "allow",
      controlProfile: null,
      rules: [
        { id: "first", kind: "amount", asset: ADDRESS_A, max: "100", action: "allow" },
        overlappingRule,
      ],
    });

    expect(state.limits).toEqual([{ asset: ADDRESS_A, max: "100" }]);
    expect(state.passthroughRules).toEqual([overlappingRule]);
  });

  it.each([
    { label: "raw_sign", families: ["raw_sign"] },
    { label: "payment + raw_sign", families: ["payment", "raw_sign"] },
  ] as const)("erases retired families from an operation-family rule: $label", ({ families }) => {
    const rule: PaymentWalletPolicy["rules"][number] = {
      id: `historical-${families.join("-")}`,
      kind: "operation_family",
      families: [...families],
      action: "deny",
    };
    const state = createPolicyAuthoringState({
      walletId: WALLET_ID,
      defaultAction: "allow",
      controlProfile: null,
      rules: [rule],
    });

    const authorable = families.filter((family) => family === "payment");
    expect(state.familyActions).toEqual(authorable.length ? { payment: "deny" } : {});
    expect(state.passthroughRules).toEqual([]);
    expect(buildPolicyPayload(WALLET_ID, state).rules).toEqual(
      authorable.length
        ? [
            {
              id: "operation-families-deny",
              kind: "operation_family",
              families: ["payment"],
              action: "deny",
              name: "Operation families: deny",
            },
          ]
        : []
    );
  });

  it("drops a family-only approval rule naming only retired families", () => {
    const rule: PaymentWalletPolicy["rules"][number] = {
      id: "historical-raw-sign-approval",
      kind: "approval",
      families: ["raw_sign"],
      action: "approval_required",
    };
    const state = createPolicyAuthoringState({
      walletId: WALLET_ID,
      defaultAction: "allow",
      controlProfile: null,
      rules: [rule],
    });

    expect(state.familyActions).toEqual({});
    expect(state.passthroughRules).toEqual([]);
    expect(state.categories).toEqual([]);
    expect(buildPolicyPayload(WALLET_ID, state).rules).toEqual([]);
  });

  it("sanitizes non-authorable family actions from a stored draft", () => {
    const storage = new MemoryStorage();
    const state = createPolicyAuthoringState(emptyPolicy());
    const draft = {
      version: 1,
      projectId: PROJECT_ID,
      walletId: WALLET_ID,
      step: "destinations-operations",
      state: {
        ...state,
        familyActions: { payment: "deny", raw_sign: "approval_required" },
      },
      updatedAt: "2026-07-15T20:00:00.000Z",
    };
    storage.setItem(policyDraftStorageKey(PROJECT_ID, WALLET_ID), JSON.stringify(draft));

    const loaded = loadPolicyDraft(storage, PROJECT_ID, WALLET_ID);

    expect(loaded?.state.familyActions).toEqual({ payment: "deny" });
  });

  it("preserves conflicting destination modes without merging their semantics", () => {
    const existing: PaymentWalletPolicy = {
      walletId: WALLET_ID,
      defaultAction: "allow",
      controlProfile: null,
      rules: [
        {
          id: "allowed-destinations",
          kind: "destination",
          allowlist: [ADDRESS_A],
          action: "allow",
        },
        {
          id: "blocked-destinations",
          kind: "destination",
          blocklist: [ADDRESS_B],
          action: "deny",
        },
      ],
    };

    const rebuilt = buildPolicyPayload(WALLET_ID, createPolicyAuthoringState(existing));

    expect(rebuilt.rules).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "destination", allowlist: [ADDRESS_A], action: "allow" }),
        expect.objectContaining({
          kind: "destination",
          blocklist: [ADDRESS_B],
          action: "deny",
        }),
      ])
    );
    expect(rebuilt.rules).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "destination", blocklist: [ADDRESS_A] }),
      ])
    );
  });
});

describe("buildPolicyAssetOptions", () => {
  const SOL_HOLDING = {
    token: "SOL",
    mint: "So11111111111111111111111111111111111111112",
    uiAmount: "1.5",
  };

  it("offers well-known mints the wallet does not hold", () => {
    const options = buildPolicyAssetOptions([SOL_HOLDING], "sandbox");
    const symbols = options.map((option) => option.token);

    expect(symbols).toContain("USDC");
    expect(symbols).toContain("PYUSD");
  });

  it("keeps the wallet holding rather than duplicating its well-known entry", () => {
    const options = buildPolicyAssetOptions([SOL_HOLDING], "sandbox");
    const solEntries = options.filter((option) => option.mint === SOL_HOLDING.mint);

    expect(solEntries).toHaveLength(1);
    expect(solEntries[0]).toMatchObject({ source: "wallet", uiAmount: "1.5" });
  });

  it("lists wallet holdings before well-known suggestions", () => {
    const options = buildPolicyAssetOptions([SOL_HOLDING], "sandbox");

    expect(options[0]?.source).toBe("wallet");
    expect(options.at(-1)?.source).toBe("well-known");
  });

  it("omits tokens that have no mint on the active cluster", () => {
    // USDT ships a mainnet mint only, so sandbox must not offer it.
    expect(buildPolicyAssetOptions([], "sandbox").map((o) => o.token)).not.toContain("USDT");
    expect(buildPolicyAssetOptions([], "production").map((o) => o.token)).toContain("USDT");
  });

  it("resolves production mints for production projects", () => {
    const usdc = buildPolicyAssetOptions([], "production").find((o) => o.token === "USDC");

    expect(usdc?.mint).toBe("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");
  });

  it("names well-known holdings from the registry even when the balance row carries the mint as its label", () => {
    const solLabeledByMint = {
      token: "So11111111111111111111111111111111111111112",
      mint: "So11111111111111111111111111111111111111112",
      uiAmount: "1.5",
    };
    const options = buildPolicyAssetOptions([solLabeledByMint], "sandbox");
    const sol = options.find((option) => option.mint === solLabeledByMint.mint);

    expect(sol).toMatchObject({ token: "SOL", name: "Solana", source: "wallet", uiAmount: "1.5" });
  });

  it("dedupes repeated wallet holdings", () => {
    const options = buildPolicyAssetOptions([SOL_HOLDING, SOL_HOLDING], "sandbox");

    expect(options.filter((option) => option.mint === SOL_HOLDING.mint)).toHaveLength(1);
  });

  const ISSUED_ACME = {
    token: "ACME",
    name: "Acme Token",
    mint: "MintAcme",
    imageUrl: "https://cdn.example/acme.png",
  };

  it("offers issued tokens as their own source", () => {
    const options = buildPolicyAssetOptions([SOL_HOLDING], "sandbox", [ISSUED_ACME]);
    const acme = options.find((option) => option.mint === ISSUED_ACME.mint);

    expect(acme).toMatchObject({
      token: "ACME",
      name: "Acme Token",
      imageUrl: "https://cdn.example/acme.png",
      sdpIssued: true,
      source: "issued",
    });
  });

  it("keeps an issued token the wallet holds in the wallet group with its balance", () => {
    const held = { token: "ACME", mint: "MintAcme", uiAmount: "5000" };
    const options = buildPolicyAssetOptions([held], "sandbox", [ISSUED_ACME]);
    const entries = options.filter((option) => option.mint === ISSUED_ACME.mint);

    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      source: "wallet",
      uiAmount: "5000",
      name: "Acme Token",
      imageUrl: "https://cdn.example/acme.png",
      sdpIssued: true,
    });
  });

  it("prefers the issued entry over a colliding well-known mint", () => {
    const usdcMainnet = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
    const options = buildPolicyAssetOptions([], "production", [
      { token: "ACME", name: "Acme Token", mint: usdcMainnet },
    ]);
    const entries = options.filter((option) => option.mint === usdcMainnet);

    expect(entries).toHaveLength(1);
    expect(entries[0]?.source).toBe("issued");
  });

  it("does not filter issued tokens by cluster", () => {
    // `issued_tokens` is scoped by project and the dashboard derives its environment
    // from the selected project, so the API has already applied the cluster boundary.
    // Re-filtering here would drop legitimate tokens; this pins that contract.
    for (const environment of ["sandbox", "production"] as const) {
      const options = buildPolicyAssetOptions([], environment, [ISSUED_ACME]);

      expect(options.some((option) => option.mint === ISSUED_ACME.mint)).toBe(true);
    }
  });

  it("produces the same options as before when no issued tokens are supplied", () => {
    expect(buildPolicyAssetOptions([SOL_HOLDING], "sandbox", [])).toEqual(
      buildPolicyAssetOptions([SOL_HOLDING], "sandbox")
    );
  });

  it("skips issued tokens with a blank mint", () => {
    const options = buildPolicyAssetOptions([], "sandbox", [{ token: "GHOST", mint: "" }]);

    expect(options.some((option) => option.token === "GHOST")).toBe(false);
  });

  it("offers the tokens that are genuinely deployed on devnet", () => {
    const symbols = buildPolicyAssetOptions([], "sandbox").map((option) => option.token);

    expect(symbols).toContain("EURC");
    expect(symbols).toContain("JitoSOL");
    expect(symbols).toContain("mSOL");
    expect(symbols).toContain("bSOL");
  });

  it("withholds tokens whose devnet address is not the same asset", () => {
    const symbols = buildPolicyAssetOptions([], "sandbox").map((option) => option.token);

    // An account exists at the USDS address on devnet, but it is a different
    // mint with 9 decimals; offering it would misscale every amount.
    expect(symbols).not.toContain("USDS");
    // These resolve to System Program accounts on devnet rather than mints.
    expect(symbols).not.toContain("cbBTC");
    expect(symbols).not.toContain("INF");
  });

  it("carries the catalogue name and category through to the picker", () => {
    const usdc = buildPolicyAssetOptions([], "production").find(
      (option) => option.token === "USDC"
    );

    expect(usdc).toMatchObject({ name: "USD Coin", category: "stablecoin" });
  });

  it("labels staked SOL and wrapped assets by category on mainnet", () => {
    const options = buildPolicyAssetOptions([], "production");

    expect(options.find((o) => o.token === "JitoSOL")?.category).toBe("staked-sol");
    expect(options.find((o) => o.token === "cbBTC")?.category).toBe("wrapped");
  });
});
