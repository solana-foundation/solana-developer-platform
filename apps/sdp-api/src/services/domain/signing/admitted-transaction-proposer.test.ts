import { generateKeyPairSync, sign } from "node:crypto";
import { runInClusterScope } from "@sdp/rpc/scope";
import {
  address,
  appendTransactionMessageInstruction,
  blockhash,
  compileTransaction,
  createTransactionMessage,
  getBase58Decoder,
  getBase64EncodedWireTransaction,
  getBase64Encoder,
  getTransactionDecoder,
  pipe,
  setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash,
} from "@solana/kit";
import { describe, expect, it, vi } from "vitest";
import type { MoneyAdmissionDecision } from "@/lib/money-admission";
import { type ProposalAccess, ProposalNotSentError } from "./admitted-proposer";
import {
  admittedTransactionProposer,
  type TransactionProposalPort,
  type TransactionProposalResult,
} from "./admitted-transaction-proposer";

const key = generateKeyPairSync("ed25519");
const owner = getBase58Decoder().decode(
  new Uint8Array(key.publicKey.export({ format: "der", type: "spki" }).subarray(-32))
);
const access: ProposalAccess = {
  apiKey: "key",
  apiSecretPem: "not-read-by-test-port",
  vaultAccountId: "42",
  publicKey: owner,
  connectionId: "connection_1",
  accountFingerprint: "fingerprint",
  assetId: "SOL_TEST",
};
const binding = {
  provider: "fireblocks" as const,
  externalId: "attempt_1",
  connectionId: access.connectionId,
  accountFingerprint: access.accountFingerprint,
  vaultAccountId: access.vaultAccountId,
  assetId: access.assetId,
  sourceAddress: owner,
};
const context = {
  organizationId: "org_1",
  projectId: "project_1",
  custodyWalletId: "wallet_1",
  movement: "earn.deposit" as const,
  address: owner,
};
const admitted: MoneyAdmissionDecision = { admitted: true };
const refused: MoneyAdmissionDecision = { admitted: false, reason: "movement_disabled" };
const inScope = <T>(work: () => Promise<T>) =>
  runInClusterScope({ projectId: "project_1", environment: "sandbox" }, work);

function transaction(text = "deposit") {
  return compileTransaction(
    pipe(
      createTransactionMessage({ version: 0 }),
      (message) => setTransactionMessageFeePayer(address(owner), message),
      (message) =>
        setTransactionMessageLifetimeUsingBlockhash(
          { blockhash: blockhash("11111111111111111111111111111111"), lastValidBlockHeight: 100n },
          message
        ),
      (message) =>
        appendTransactionMessageInstruction(
          {
            programAddress: address("MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr"),
            data: new TextEncoder().encode(text),
          },
          message
        )
    )
  );
}
const unsigned = getBase64EncodedWireTransaction(transaction());
function result(status = "PENDING_AUTHORIZATION"): TransactionProposalResult {
  return {
    id: "proposal_1",
    status,
    operation: "PROGRAM_CALL",
    externalTxId: binding.externalId,
    assetId: binding.assetId,
    source: { type: "VAULT_ACCOUNT", id: binding.vaultAccountId },
  };
}
function port(): TransactionProposalPort {
  return {
    propose: vi.fn(async () => result()),
    read: vi.fn(async () => result()),
    cancel: vi.fn(async () => true),
  };
}
function create(
  provider: TransactionProposalPort,
  decide: () => Promise<MoneyAdmissionDecision> = async () => admitted,
  live = async () => access
) {
  return admittedTransactionProposer(
    { prepare: async () => access, live, recovery: async () => access },
    decide,
    context,
    provider
  );
}

describe("Earn transaction proposal admission boundary", () => {
  it("preparation reads identity only and never opens approval", async () => {
    const provider = port();
    expect(await inScope(() => create(provider).prepare(binding.externalId))).toEqual(binding);
    expect(provider.propose).not.toHaveBeenCalled();
    expect(provider.read).not.toHaveBeenCalled();
  });

  it("revoked authority refuses before provider I/O", async () => {
    const provider = port();
    await expect(
      inScope(() =>
        create(provider, async () => refused).propose({ binding, unsignedTransaction: unsigned })
      )
    ).rejects.toBeInstanceOf(ProposalNotSentError);
    expect(provider.propose).not.toHaveBeenCalled();
  });

  it("changed credential account and wrong transaction owner refuse before provider I/O", async () => {
    const provider = port();
    await expect(
      inScope(() =>
        create(
          provider,
          async () => admitted,
          async () => ({ ...access, accountFingerprint: "changed" })
        ).propose({ binding, unsignedTransaction: unsigned })
      )
    ).rejects.toBeInstanceOf(ProposalNotSentError);
    await expect(
      inScope(() =>
        create(provider).propose({
          binding: { ...binding, sourceAddress: "11111111111111111111111111111111" },
          unsignedTransaction: unsigned,
        })
      )
    ).rejects.toBeInstanceOf(ProposalNotSentError);
    expect(provider.propose).not.toHaveBeenCalled();
  });

  it("pending proposals return immediately without an in-request poll", async () => {
    const provider = port();
    const observed = await inScope(() =>
      create(provider).propose({ binding, unsignedTransaction: unsigned })
    );
    expect(observed.phase).toBe("pending");
    expect(provider.propose).toHaveBeenCalledTimes(1);
    expect(provider.read).not.toHaveBeenCalled();
    expect(provider.propose).toHaveBeenCalledWith(access, {
      binding,
      unsignedTransaction: unsigned,
    });
  });

  it("recovery verifies signature over exact original message and never broadcasts", async () => {
    const signature = sign(null, Buffer.from(transaction().messageBytes), key.privateKey).toString(
      "hex"
    );
    const provider = port();
    vi.mocked(provider.read).mockResolvedValue({
      ...result("SIGNED"),
      signedMessages: [{ signature: { fullSig: signature } }],
    });
    const observed = await inScope(() =>
      create(provider, async () => refused).read({ binding, unsignedTransaction: unsigned })
    );
    expect(observed?.phase).toBe("signed");
    if (observed?.signedTransaction == null) throw new Error("Expected verified transaction");
    const signed = getTransactionDecoder().decode(
      getBase64Encoder().encode(observed.signedTransaction)
    );
    expect(signed.messageBytes).toEqual(transaction().messageBytes);
    expect(provider.propose).not.toHaveBeenCalled();
    await expect(
      inScope(() =>
        create(provider).read({
          binding,
          unsignedTransaction: getBase64EncodedWireTransaction(transaction("different")),
        })
      )
    ).rejects.toThrow("does not sign");
  });

  it("cleanup checks provider identity and remains possible after admission refusal", async () => {
    const provider = port();
    expect(await inScope(() => create(provider, async () => refused).cancel(binding))).toBe(true);
    expect(provider.cancel).toHaveBeenCalledWith(access, "proposal_1");
    vi.mocked(provider.read).mockResolvedValue({ ...result(), externalTxId: "unrelated" });
    await expect(inScope(() => create(provider).cancel(binding))).rejects.toThrow("does not match");
    expect(provider.cancel).toHaveBeenCalledTimes(1);
  });
});
