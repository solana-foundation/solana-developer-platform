import type { BuildOperationInput } from "@sdp/helius-rings";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * How a private transfer resolves its recipient.
 *
 * The claim under test is that it needs none of the recipient's key material.
 * Every half of a recipient's identity is public and already on chain, so the
 * sender reads the registry — which is what lets a recipient in another project,
 * or another tenant's custody entirely, be paid at all.
 */

const buildTransfer = vi.fn();
const buildWithdrawal = vi.fn();
const hydrateWallet = vi.fn();
const spendKeys = vi.fn();
const fetchUserRecord = vi.fn();

vi.mock("./flows/spend.js", () => ({
  buildTransfer: (...args: unknown[]) => buildTransfer(...args),
  buildWithdrawal: (...args: unknown[]) => buildWithdrawal(...args),
}));

vi.mock("./keys.js", () => ({
  spendKeys: (...args: unknown[]) => spendKeys(...args),
}));

vi.mock("./wallet.js", () => ({
  hydrateWallet: (...args: unknown[]) => hydrateWallet(...args),
}));

// `resolvedAddressFromRecord` stays real: that it rebuilds the recipient's
// address from published halves is the behaviour being relied on.
vi.mock("@heliuslabs/zolana/wallet", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@heliuslabs/zolana/wallet")>()),
  fetchUserRecord: (...args: unknown[]) => fetchUserRecord(...args),
}));

const { buildRingsOperation } = await import("./build.js");
const { derivedIdentity, honestRecord, TEST_FOREIGN_REQUEST, TEST_OWNER, testSignMessage } =
  await import("./test/shielded-identity-fixtures.js");
const { createCustodyMaterialSource } = await import("./custody-ka/index.js");
const { clearSeedCache } = await import("./custody-ka/seed-cache.js");

const RECIPIENT = TEST_FOREIGN_REQUEST.owner;
const BLOCKHASH = "5DjPMLBWWLbNw3TRUEbCwPFvpXqhkdVv2VUb3RJhZmpJ";

function transferInput(expectedShieldedAddress: string): BuildOperationInput {
  return {
    owner: TEST_OWNER,
    operation: {
      id: "op_1",
      walletId: "hrw_1",
      opType: "transfer_registered",
      state: "proving",
      approvalRequestId: null,
      policyEvaluationId: null,
      proof: null,
      outerTxSignature: null,
      photonIndexedAt: null,
      failure: null,
      ringProgramId: null,
      input: {
        walletId: "hrw_1",
        opType: "transfer_registered",
        asset: { mint: "So11111111111111111111111111111111111111112", amountRaw: "1" },
        clientNonce: "nonce_1",
      },
      intentKey: "sha256:intent",
      events: [],
      createdAt: "2026-08-25T00:00:00.000Z",
      updatedAt: "2026-08-25T00:00:00.000Z",
      retryOfOperationId: null,
    } as never,
    recipient: { walletId: "hrw_2", owner: RECIPIENT, expectedShieldedAddress },
  } as BuildOperationInput;
}

function deps(signMessage = testSignMessage) {
  return {
    client: {
      getLatestBlockhash: vi
        .fn()
        .mockResolvedValue({ blockhash: BLOCKHASH, lastValidBlockHeight: 1_000n }),
    } as never,
    material: createCustodyMaterialSource({ signMessage, cache: { ttlMs: 0 } }),
    organizationId: "org_1",
    projectId: "proj_1",
  };
}

describe("buildRingsOperation recipient resolution", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clearSeedCache();
    spendKeys.mockReturnValue({ destroy: vi.fn() });
    hydrateWallet.mockResolvedValue({ wallet: {} });
    buildTransfer.mockResolvedValue({ instructions: [], inputNotes: [] });
  });

  it("resolves the recipient without asking custody to sign for them", async () => {
    const signMessage = vi.fn(testSignMessage);
    fetchUserRecord.mockResolvedValue(await honestRecord({ request: TEST_FOREIGN_REQUEST }));

    await buildRingsOperation(
      deps(signMessage),
      transferInput(await derivedIdentity(TEST_FOREIGN_REQUEST))
    );

    // Exactly one signature, for the sender. A recipient's seed is not the
    // sender's to fetch, and across tenants it would not be fetchable at all.
    expect(signMessage).toHaveBeenCalledExactlyOnceWith(expect.any(String), TEST_OWNER);
    expect(fetchUserRecord).toHaveBeenCalledWith(expect.objectContaining({ owner: RECIPIENT }));
  });

  it("hands the builder the address the registry publishes", async () => {
    fetchUserRecord.mockResolvedValue(await honestRecord({ request: TEST_FOREIGN_REQUEST }));
    const expected = await derivedIdentity(TEST_FOREIGN_REQUEST);

    await buildRingsOperation(deps(), transferInput(expected));

    const recipient = buildTransfer.mock.calls[0]?.[1]?.recipient;
    const { canonicalShieldedIdentity } = await import("./material.js");
    expect(canonicalShieldedIdentity(recipient)).toBe(expected);
  });

  it("refuses a recipient with no published record", async () => {
    fetchUserRecord.mockResolvedValue(undefined);

    await expect(
      buildRingsOperation(deps(), transferInput(await derivedIdentity(TEST_FOREIGN_REQUEST)))
    ).rejects.toMatchObject({ code: "conflict" });
    expect(buildTransfer).not.toHaveBeenCalled();
  });

  it("refuses when the registry publishes an identity the caller did not expect", async () => {
    // A recipient re-keyed between the caller reading it and the build. Paying
    // the new identity silently would send funds to keys the caller never saw.
    fetchUserRecord.mockResolvedValue(await honestRecord({ request: TEST_FOREIGN_REQUEST }));

    await expect(
      buildRingsOperation(deps(), transferInput(await derivedIdentity()))
    ).rejects.toMatchObject({ code: "conflict" });
    expect(buildTransfer).not.toHaveBeenCalled();
  });
});
