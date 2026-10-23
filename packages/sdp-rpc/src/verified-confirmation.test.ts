import assert from "node:assert/strict";
import test from "node:test";
import {
  type AccountInfoBase,
  type AccountInfoWithBase64EncodedData,
  type Address,
  address,
  type Base64EncodedBytes,
  type Commitment,
  type GetSignatureStatusesApi,
  getBase64Decoder,
  lamports,
  type Signature,
  type TransactionError,
} from "@solana/kit";
import type { SolanaRpc } from "./solana";
import {
  type JsonParsedTransactionResponse,
  jsonParsedTransactionMeta,
  jsonParsedTransactionResponse,
} from "./test-fixtures";
import { verifyTransactionLanded } from "./verified-confirmation";

type SignatureStatus = NonNullable<
  ReturnType<GetSignatureStatusesApi["getSignatureStatuses"]>["value"][number]
>;

type EncodedAccountValue = AccountInfoBase &
  AccountInfoWithBase64EncodedData & { rentEpoch: bigint };

const SIG = "sig111" as Signature;
const MINT = "mint111" as Address;
const TOKEN_2022_PROGRAM = address("TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb");
const MINT_AUTHORITY = address("k7FaK87WHGVXzkaoHb7CdVPgkKDQhZ29VLDeBVbDfYn");

function signatureStatus(params: {
  confirmationStatus: Commitment;
  err: TransactionError | null;
}): SignatureStatus {
  return {
    confirmationStatus: params.confirmationStatus,
    confirmations: 5n,
    err: params.err,
    slot: 100n,
    status: params.err === null ? { Ok: null } : { Err: params.err },
  };
}

const CONFIRMED_STATUS = signatureStatus({ confirmationStatus: "confirmed", err: null });

const MINT_ACCOUNT: EncodedAccountValue = {
  data: [getBase64Decoder().decode(new Uint8Array(82)) as Base64EncodedBytes, "base64"],
  executable: false,
  lamports: lamports(1_461_600n),
  owner: TOKEN_2022_PROGRAM,
  rentEpoch: 18_446_744_073_709_551_615n,
  space: 82n,
};

const INITIALIZE_MINT_TRANSACTION = jsonParsedTransactionResponse({
  meta: jsonParsedTransactionMeta({ err: null, preTokenBalances: [], postTokenBalances: [] }),
  instructions: [
    {
      parsed: {
        info: { decimals: 6, freezeAuthority: null, mint: MINT, mintAuthority: MINT_AUTHORITY },
        type: "initializeMint2",
      },
      program: "spl-token-2022",
      programId: TOKEN_2022_PROGRAM,
    },
  ],
});

function fakeRpc(responses: {
  status: SignatureStatus | null;
  account: EncodedAccountValue | null;
  transaction: JsonParsedTransactionResponse | null;
}): SolanaRpc {
  return {
    getSignatureStatuses: () => ({
      send: async () => ({ context: { slot: 100n }, value: [responses.status] }),
    }),
    getAccountInfo: () => ({
      send: async () => ({ context: { slot: 100n }, value: responses.account }),
    }),
    getTransaction: () => ({
      send: async () => responses.transaction,
    }),
  } as unknown as SolanaRpc;
}

test("returns ok with status and parsed transaction when everything lands", async () => {
  const rpc = fakeRpc({
    status: CONFIRMED_STATUS,
    account: MINT_ACCOUNT,
    transaction: INITIALIZE_MINT_TRANSACTION,
  });
  const result = await verifyTransactionLanded(rpc, SIG, { expectAccount: MINT });
  assert.ok(result.ok);
  assert.equal(result.status.confirmationStatus, "confirmed");
  assert.equal(result.transaction.instructions.length, 1);
});

test("not_confirmed when the RPC has no status for the signature", async () => {
  const result = await verifyTransactionLanded(
    fakeRpc({ status: null, account: null, transaction: null }),
    SIG
  );
  assert.deepEqual(result, { ok: false, reason: "not_confirmed" });
});

test("not_confirmed when the transaction errored on-chain", async () => {
  const result = await verifyTransactionLanded(
    fakeRpc({
      status: signatureStatus({
        confirmationStatus: "confirmed",
        err: { InstructionError: [0, { Custom: 1 }] },
      }),
      account: null,
      transaction: null,
    }),
    SIG
  );
  assert.deepEqual(result, { ok: false, reason: "not_confirmed" });
});

test("not_confirmed when the status is processed-only", async () => {
  const result = await verifyTransactionLanded(
    fakeRpc({
      status: signatureStatus({ confirmationStatus: "processed", err: null }),
      account: null,
      transaction: null,
    }),
    SIG
  );
  assert.deepEqual(result, { ok: false, reason: "not_confirmed" });
});

test("account_missing when expectAccount does not exist", async () => {
  const result = await verifyTransactionLanded(
    fakeRpc({ status: CONFIRMED_STATUS, account: null, transaction: INITIALIZE_MINT_TRANSACTION }),
    SIG,
    { expectAccount: MINT }
  );
  assert.deepEqual(result, { ok: false, reason: "account_missing" });
});

test("skips the account check when expectAccount is omitted", async () => {
  const result = await verifyTransactionLanded(
    fakeRpc({ status: CONFIRMED_STATUS, account: null, transaction: INITIALIZE_MINT_TRANSACTION }),
    SIG
  );
  assert.ok(result.ok);
});

test("not_indexed when getTransaction returns null for a confirmed signature", async () => {
  const result = await verifyTransactionLanded(
    fakeRpc({ status: CONFIRMED_STATUS, account: MINT_ACCOUNT, transaction: null }),
    SIG,
    { expectAccount: MINT }
  );
  assert.deepEqual(result, { ok: false, reason: "not_indexed" });
});

test("retries a transient status failure instead of surfacing it", async () => {
  let calls = 0;
  const rpc = {
    getSignatureStatuses: () => ({
      send: async () => {
        calls += 1;
        if (calls === 1) throw new Error("fetch failed");
        return { context: { slot: 100n }, value: [CONFIRMED_STATUS] };
      },
    }),
    getAccountInfo: () => ({
      send: async () => ({ context: { slot: 100n }, value: MINT_ACCOUNT }),
    }),
    getTransaction: () => ({ send: async () => INITIALIZE_MINT_TRANSACTION }),
  } as unknown as SolanaRpc;
  const result = await verifyTransactionLanded(rpc, SIG, { expectAccount: MINT });
  assert.ok(result.ok);
  assert.equal(calls, 2);
});

test("rethrows a persistent RPC failure", async () => {
  const rpc = {
    getSignatureStatuses: () => ({
      send: async () => {
        throw new Error("401 Unauthorized");
      },
    }),
  } as unknown as SolanaRpc;
  await assert.rejects(verifyTransactionLanded(rpc, SIG), /401/);
});
