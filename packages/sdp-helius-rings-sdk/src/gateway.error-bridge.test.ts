import { ClientError } from "@heliuslabs/zolana/client";
import { InterfaceError } from "@heliuslabs/zolana/interface";
import { TransactionError } from "@heliuslabs/zolana/transaction";
import { WalletError } from "@heliuslabs/zolana/wallet";
import { HeliusRingsError, type HeliusRingsErrorCode } from "@sdp/helius-rings";
import { SOLANA_ERROR__ADDRESSES__STRING_LENGTH_OUT_OF_RANGE, SolanaError } from "@solana/kit";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RingsGatewayConfig } from "./gateway.js";

const createRingsClient = vi.fn();
const provisionRingsIdentity = vi.fn();
const syncRingsWallet = vi.fn();
const buildRingsOperation = vi.fn();
const verifyRingsIndexed = vi.fn();

vi.mock("./client.js", () => ({
  createRingsClient: (...args: unknown[]) => createRingsClient(...args),
}));
vi.mock("./provision.js", () => ({
  provisionRingsIdentity: (...args: unknown[]) => provisionRingsIdentity(...args),
}));
vi.mock("./sync.js", () => ({
  syncRingsWallet: (...args: unknown[]) => syncRingsWallet(...args),
}));
vi.mock("./build.js", () => ({
  buildRingsOperation: (...args: unknown[]) => buildRingsOperation(...args),
}));
vi.mock("./indexed.js", () => ({
  verifyRingsIndexed: (...args: unknown[]) => verifyRingsIndexed(...args),
}));

const { createRingsGateway } = await import("./gateway.js");

const CONFIG: RingsGatewayConfig = {
  solanaRpcUrl: "https://rpc.example",
  indexerUrl: "https://indexer.example",
  proverUrl: "https://prover.example",
  organizationId: "org_1",
  projectId: "proj_1",
  derivationSeed: Buffer.alloc(32, 7).toString("base64"),
  signTransaction: (transaction) => Promise.resolve(transaction),
  submitTransaction: () => Promise.resolve("signature"),
};

const MESSAGES = {
  config_error: "the Rings gateway configuration is invalid",
  conflict: "the Rings wallet state conflicts with the requested operation",
  gateway_unavailable: "a Rings upstream service is unavailable",
  insufficient_balance: "the Rings wallet has insufficient spendable balance",
  invalid_input: "the Rings request contains invalid input",
} as const;

async function rejection(work: () => Promise<unknown>): Promise<unknown> {
  return work().then(
    () => null,
    (error: unknown) => error
  );
}

function expectMapped(
  error: unknown,
  code: keyof typeof MESSAGES
): asserts error is HeliusRingsError {
  expect(error).toBeInstanceOf(HeliusRingsError);
  expect(error).toMatchObject<Partial<HeliusRingsError>>({
    name: "HeliusRingsError",
    code: code as HeliusRingsErrorCode,
    message: MESSAGES[code],
  });
}

describe("Zolana errors at the Rings gateway boundary", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    createRingsClient.mockResolvedValue({});
  });

  it("maps a published-identity mismatch during provision to conflict without leaking details", async () => {
    const sensitive = "seed-material-at-https://private.example";
    provisionRingsIdentity.mockRejectedValue(
      new WalletError("WALLET_REGISTERED_KEYPAIR_MISMATCH", {
        details: { diagnostic: sensitive },
        cause: new Error(sensitive),
      })
    );

    const error = await rejection(() =>
      createRingsGateway(CONFIG).provisionIdentity({
        walletId: "hrw_1",
        sdpAddress: "owner",
      })
    );

    expectMapped(error, "conflict");
    expect(error.message).not.toContain(sensitive);
    expect(error.cause).toBeUndefined();
  });

  it("maps a direct TransactionError during provision", async () => {
    provisionRingsIdentity.mockRejectedValue(new TransactionError("TRANSACTION_INVALID_ADDRESS"));

    const error = await rejection(() =>
      createRingsGateway(CONFIG).provisionIdentity({
        walletId: "hrw_1",
        sdpAddress: "owner",
      })
    );

    expectMapped(error, "invalid_input");
  });

  it("maps invalid wallet sync configuration as a configuration error", async () => {
    syncRingsWallet.mockRejectedValue(
      new WalletError("WALLET_INVALID_SYNC_CONFIG", {
        details: { field: "pageLimit" },
      })
    );

    const error = await rejection(() =>
      createRingsGateway(CONFIG).syncPhoton({ walletId: "hrw_1", owner: "owner" })
    );

    expectMapped(error, "config_error");
  });

  it("maps a TransactionError nested in WalletError during sync", async () => {
    const cause = new TransactionError("TRANSACTION_WALLET_AUTHORITY_MISMATCH");
    syncRingsWallet.mockRejectedValue(
      new WalletError("WALLET_SYNC", {
        causeCode: cause.code,
        cause,
      })
    );

    const error = await rejection(() =>
      createRingsGateway(CONFIG).syncPhoton({ walletId: "hrw_1", owner: "owner" })
    );

    expectMapped(error, "conflict");
  });

  it("maps invalid base64 from an upstream sync response as gateway unavailability", async () => {
    syncRingsWallet.mockRejectedValue(
      new ClientError("CLIENT_INVALID_BASE64", {
        details: { field: "message.payload" },
      })
    );

    const error = await rejection(() =>
      createRingsGateway(CONFIG).syncPhoton({ walletId: "hrw_1", owner: "owner" })
    );

    expectMapped(error, "gateway_unavailable");
  });

  it("maps an actual build shortfall as insufficient balance", async () => {
    buildRingsOperation.mockRejectedValue(new WalletError("WALLET_INSUFFICIENT_BALANCE"));

    const error = await rejection(() =>
      createRingsGateway(CONFIG).buildOperation({
        operation: {} as never,
        owner: "owner",
      })
    );

    expectMapped(error, "insufficient_balance");
  });

  it("maps selected balance overflow as invalid input rather than a shortfall", async () => {
    buildRingsOperation.mockRejectedValue(new WalletError("WALLET_SELECTED_BALANCE_OVERFLOW"));

    const error = await rejection(() =>
      createRingsGateway(CONFIG).buildOperation({
        operation: {} as never,
        owner: "owner",
      })
    );

    expectMapped(error, "invalid_input");
  });

  it.each([
    ["INTERFACE_INVALID_ADDRESS", "invalid_input"],
    ["INTERFACE_INVALID_LENGTH", "invalid_input"],
    ["INTERFACE_INVALID_INTEGER", "invalid_input"],
    ["INTERFACE_INVALID_DISCRIMINATOR", "invalid_input"],
    ["INTERFACE_INVALID_SHAPE", "invalid_input"],
    ["INTERFACE_TRANSACTION_TOO_LARGE", "invalid_input"],
    ["INTERFACE_INVALID_ACCOUNT_DATA", "gateway_unavailable"],
    ["INTERFACE_HASH", "gateway_unavailable"],
    ["INTERFACE_CODEC", "gateway_unavailable"],
  ] as const)("maps build InterfaceError %s to %s", async (upstreamCode, domainCode) => {
    const sensitive = "account-data-from-https://private.example";
    buildRingsOperation.mockRejectedValue(
      new InterfaceError(upstreamCode, { diagnostic: sensitive }, new Error(sensitive))
    );

    const error = await rejection(() =>
      createRingsGateway(CONFIG).buildOperation({
        operation: {} as never,
        owner: "owner",
      })
    );

    expectMapped(error, domainCode);
    expect(error.message).not.toContain(sensitive);
    expect(error.cause).toBeUndefined();
  });

  it("maps an oversized shield InterfaceError through its WalletError wrapper", async () => {
    const sensitive = "oversized-shield-at-https://private.example";
    const cause = new InterfaceError(
      "INTERFACE_TRANSACTION_TOO_LARGE",
      { diagnostic: sensitive },
      new Error(sensitive)
    );
    buildRingsOperation.mockRejectedValue(
      new WalletError("WALLET_BUILD_DEPOSIT", {
        causeCode: cause.code,
        cause,
      })
    );

    const error = await rejection(() =>
      createRingsGateway(CONFIG).buildOperation({
        operation: {} as never,
        owner: "owner",
      })
    );

    expectMapped(error, "invalid_input");
    expect(error.message).not.toContain(sensitive);
    expect(error.cause).toBeUndefined();
  });

  it("maps pre-persistence tree mismatches as conflict, never reconciliation", async () => {
    buildRingsOperation.mockRejectedValue(
      new ClientError("CLIENT_TREE_MISMATCH", {
        details: { transactionTree: "tree-a", clientTree: "tree-b" },
      })
    );

    const error = await rejection(() =>
      createRingsGateway(CONFIG).buildOperation({
        operation: {} as never,
        owner: "owner",
      })
    );

    expectMapped(error, "conflict");
    expect((error as HeliusRingsError).code).not.toBe("manual_reconciliation_required");
  });

  it.each([
    ["wallet", new WalletError("WALLET_MERGE_TREE_MISMATCH")],
    [
      "client",
      new ClientError("CLIENT_MERGE_TREE_MISMATCH", {
        details: { proofTree: "tree-a", submitTree: "tree-b" },
      }),
    ],
  ])("maps %s merge-proof tree mismatch as gateway unavailability", async (_source, upstream) => {
    buildRingsOperation.mockRejectedValue(upstream);

    const error = await rejection(() =>
      createRingsGateway(CONFIG).buildOperation({
        operation: {} as never,
        owner: "owner",
      })
    );

    expectMapped(error, "gateway_unavailable");
  });

  it.each([
    new ClientError("CLIENT_MISSING_INPUT_MERKLE_PROOF", { details: { index: 0 } }),
    new ClientError("CLIENT_INCOMPLETE_INPUT_PROOFS", {
      details: { expected: 2, state: 1, nullifier: 2 },
    }),
    new ClientError("CLIENT_STATE_PROOF_LEAF_MISMATCH", { details: { index: 0 } }),
    new ClientError("CLIENT_STATE_PROOF_TREE_MISMATCH", { details: { index: 0 } }),
    new ClientError("CLIENT_NULLIFIER_PROOF_LEAF_MISMATCH", { details: { index: 0 } }),
    new ClientError("CLIENT_NULLIFIER_PROOF_TREE_MISMATCH", { details: { index: 0 } }),
    new ClientError("CLIENT_PROOF_PATH_LENGTH", {
      details: { got: 20, expected: 32, index: 0, kind: "state" },
    }),
    new ClientError("CLIENT_PROOF_INPUT_COUNT_MISMATCH", {
      details: { got: 1, expected: 2 },
    }),
    new ClientError("CLIENT_PROOF_TREE_MISMATCH", { details: { index: 0 } }),
  ])("maps malformed upstream proof response %s as gateway unavailability", async (upstream) => {
    buildRingsOperation.mockRejectedValue(upstream);

    const error = await rejection(() =>
      createRingsGateway(CONFIG).buildOperation({
        operation: {} as never,
        owner: "owner",
      })
    );

    expectMapped(error, "gateway_unavailable");
  });

  it("maps wrapped transaction balance overflow as invalid input", async () => {
    buildRingsOperation.mockRejectedValue(
      new ClientError("CLIENT_TRANSACTION", {
        details: { code: "TRANSACTION_WALLET_BALANCE_OVERFLOW" },
      })
    );

    const error = await rejection(() =>
      createRingsGateway(CONFIG).buildOperation({
        operation: {} as never,
        owner: "owner",
      })
    );

    expectMapped(error, "invalid_input");
  });

  it("maps a direct input-owner mismatch during build as conflict", async () => {
    buildRingsOperation.mockRejectedValue(new TransactionError("TRANSACTION_INPUT_OWNER_MISMATCH"));

    const error = await rejection(() =>
      createRingsGateway(CONFIG).buildOperation({
        operation: {} as never,
        owner: "owner",
      })
    );

    expectMapped(error, "conflict");
  });

  it("maps the ClientError nested inside a wallet build wrapper", async () => {
    const cause = new ClientError("CLIENT_INVALID_BASE58", {
      details: { field: "recipient" },
    });
    buildRingsOperation.mockRejectedValue(
      new WalletError("WALLET_BUILD_TRANSFER", {
        causeCode: cause.code,
        cause,
      })
    );

    const error = await rejection(() =>
      createRingsGateway(CONFIG).buildOperation({
        operation: {} as never,
        owner: "owner",
      })
    );

    expectMapped(error, "invalid_input");
  });

  it("maps verifyIndexed transport failure as gateway unavailability", async () => {
    verifyRingsIndexed.mockRejectedValue(
      new ClientError("CLIENT_REQUEST", {
        details: { method: "getShieldedTransactionsBySignature", retryable: true },
      })
    );

    const error = await rejection(() => createRingsGateway(CONFIG).verifyIndexed("signature"));

    expectMapped(error, "gateway_unavailable");
  });

  it("does not treat an arbitrary SolanaError as gateway configuration", async () => {
    const upstream = new SolanaError(SOLANA_ERROR__ADDRESSES__STRING_LENGTH_OUT_OF_RANGE, {
      actualLength: 3,
    });
    verifyRingsIndexed.mockRejectedValue(upstream);

    const error = await rejection(() => createRingsGateway(CONFIG).verifyIndexed("signature"));

    expect(error).toBe(upstream);
  });

  it("rethrows an unknown non-Zolana error unchanged", async () => {
    const upstream = new Error("existing unknown-error behavior");
    verifyRingsIndexed.mockRejectedValue(upstream);

    const error = await rejection(() => createRingsGateway(CONFIG).verifyIndexed("signature"));

    expect(error).toBe(upstream);
  });
});
