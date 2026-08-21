import assert from "node:assert/strict";
import test from "node:test";
import type { Address, Signature } from "@solana/kit";
import type { SolanaRpc } from "./solana";
import { verifyTransactionLanded } from "./verified-confirmation";

const SIG = "sig111" as Signature;
const MINT = "mint111" as Address;

const CONFIRMED_STATUS = {
  slot: 100n,
  confirmations: 5n,
  confirmationStatus: "confirmed",
  err: null,
};

const TX_RESPONSE = {
  slot: 100n,
  meta: { err: null, innerInstructions: [] },
  transaction: { message: { instructions: [{ programId: "prog" }] } },
};

function fakeRpc(overrides: { status?: unknown; accountValue?: unknown; tx?: unknown }): SolanaRpc {
  return {
    getSignatureStatuses: () => ({
      send: async () => ({ value: [overrides.status ?? null] }),
    }),
    getAccountInfo: () => ({
      send: async () => ({ value: overrides.accountValue ?? null }),
    }),
    getTransaction: () => ({
      send: async () => overrides.tx ?? null,
    }),
  } as unknown as SolanaRpc;
}

test("returns ok with status and parsed transaction when everything lands", async () => {
  const rpc = fakeRpc({
    status: CONFIRMED_STATUS,
    accountValue: { lamports: 1n },
    tx: TX_RESPONSE,
  });
  const result = await verifyTransactionLanded(rpc, SIG, { expectAccount: MINT });
  assert.ok(result.ok);
  assert.equal(result.status.confirmationStatus, "confirmed");
  assert.equal(result.transaction.instructions.length, 1);
});

test("not_confirmed when the RPC has no status for the signature", async () => {
  const result = await verifyTransactionLanded(fakeRpc({ status: null }), SIG);
  assert.deepEqual(result, { ok: false, reason: "not_confirmed" });
});

test("not_confirmed when the transaction errored on-chain", async () => {
  const result = await verifyTransactionLanded(
    fakeRpc({ status: { ...CONFIRMED_STATUS, err: { InstructionError: [0, "Custom"] } } }),
    SIG
  );
  assert.deepEqual(result, { ok: false, reason: "not_confirmed" });
});

test("not_confirmed when the status is processed-only", async () => {
  const result = await verifyTransactionLanded(
    fakeRpc({ status: { ...CONFIRMED_STATUS, confirmationStatus: "processed" } }),
    SIG
  );
  assert.deepEqual(result, { ok: false, reason: "not_confirmed" });
});

test("account_missing when expectAccount does not exist", async () => {
  const result = await verifyTransactionLanded(
    fakeRpc({ status: CONFIRMED_STATUS, accountValue: null, tx: TX_RESPONSE }),
    SIG,
    { expectAccount: MINT }
  );
  assert.deepEqual(result, { ok: false, reason: "account_missing" });
});

test("skips the account check when expectAccount is omitted", async () => {
  const result = await verifyTransactionLanded(
    fakeRpc({ status: CONFIRMED_STATUS, accountValue: null, tx: TX_RESPONSE }),
    SIG
  );
  assert.ok(result.ok);
});

test("not_indexed when getTransaction returns null for a confirmed signature", async () => {
  const result = await verifyTransactionLanded(
    fakeRpc({ status: CONFIRMED_STATUS, accountValue: { lamports: 1n }, tx: null }),
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
        return { value: [CONFIRMED_STATUS] };
      },
    }),
    getAccountInfo: () => ({ send: async () => ({ value: { lamports: 1n } }) }),
    getTransaction: () => ({ send: async () => TX_RESPONSE }),
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
