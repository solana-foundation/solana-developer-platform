import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import {
  AccountRole,
  type AddressesByLookupTableAddress,
  address,
  appendTransactionMessageInstructions,
  assertIsTransactionWithinSizeLimit,
  blockhash,
  compileTransaction,
  compressTransactionMessageUsingAddressLookupTables,
  createTransactionMessage,
  generateKeyPairSigner,
  getBase64EncodedWireTransaction,
  getTransactionDecoder,
  type Instruction,
  pipe,
  setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash,
  type TransactionPartialSigner,
} from "@solana/kit";
import { z } from "zod";
import { KeychainFireblocksAdapter } from "#/keychain/keychain-fireblocks.adapter";

const rsa = generateKeyPairSync("rsa", { modulusLength: 2048 });
const proposalSchema = z
  .object({
    operation: z.literal("PROGRAM_CALL"),
    assetId: z.enum(["SOL", "SOL_TEST"]),
    source: z.object({ type: z.literal("VAULT_ACCOUNT"), id: z.literal("42") }),
    extraParameters: z
      .object({
        programCallData: z.string(),
        signOnly: z.literal(true),
        useDurableNonce: z.literal(false),
      })
      .strict(),
  })
  .strict();

/** Both the native Kit plans and the provider-neutral Earn wire plans. */
interface ProposalPlan {
  cluster: string;
  instructions: readonly {
    programAddress: string;
    accounts?: readonly { address: string; role: number }[];
    data?: Instruction["data"] | string;
  }[];
}

/**
 * Send an actual provider build through the real Fireblocks SDK with HTTP stubbed.
 * Recorded chain fixtures have no private keys: replace only their owner account
 * with a local test key before compiling. Every program, instruction payload,
 * other account and signer role is retained. This proves proposal compatibility,
 * not on-chain execution or a live workspace's approval policy.
 */
export async function assertFireblocksProposal(
  plan: ProposalPlan,
  owner: string,
  lookupTables: AddressesByLookupTableAddress = {}
): Promise<void> {
  const wallet = await generateKeyPairSigner();
  const publicKey = wallet.address;
  assert(plan.instructions.length > 0, "Expected a provider-built transaction");
  const instructions: Instruction[] = plan.instructions.map((instruction) => ({
    programAddress: address(instruction.programAddress),
    accounts: instruction.accounts?.map((account) => ({
      address: account.address === owner ? publicKey : address(account.address),
      role: z.enum(AccountRole).parse(account.role),
    })),
    data:
      typeof instruction.data === "string"
        ? Buffer.from(instruction.data, "base64")
        : instruction.data,
  }));
  const transaction = compileTransaction(
    pipe(
      createTransactionMessage({ version: 0 }),
      (message) => setTransactionMessageFeePayer(publicKey, message),
      (message) =>
        setTransactionMessageLifetimeUsingBlockhash(
          {
            blockhash: blockhash("11111111111111111111111111111111"),
            lastValidBlockHeight: 100n,
          },
          message
        ),
      (message) => appendTransactionMessageInstructions(instructions, message),
      (message) => compressTransactionMessageUsingAddressLookupTables(message, lookupTables)
    )
  );
  assertIsTransactionWithinSizeLimit(transaction);
  await assertFireblocksTransaction(transaction, wallet, plan.cluster);
}

/** Also exercises immutable provider transactions with existing protocol signatures. */
export async function assertFireblocksTransaction(
  transaction: Parameters<TransactionPartialSigner["signTransactions"]>[0][number],
  wallet: TransactionPartialSigner,
  cluster: string
): Promise<void> {
  const publicKey = wallet.address;
  const assetId = cluster === "mainnet-beta" ? "SOL" : "SOL_TEST";
  const [expected] = await wallet.signTransactions([transaction]);
  const expectedSignature = Buffer.from(expected[publicKey]);
  const previousFetch = globalThis.fetch;
  const requests: { url: string; init: RequestInit | undefined }[] = [];
  try {
    globalThis.fetch = async (input, init) => {
      const url = String(input);
      requests.push({ url, init });
      if (requests.length === 1) return Response.json({ addresses: [{ address: publicKey }] });
      if (requests.length === 2) {
        return Response.json({ id: "proposal", status: "PENDING_AUTHORIZATION" });
      }
      return Response.json({
        id: "proposal",
        status: "SIGNED",
        signedMessages: [{ signature: { fullSig: expectedSignature.toString("hex") } }],
      });
    };
    const adapter = new KeychainFireblocksAdapter({
      apiKey: "tenant-key",
      apiSecretPem: rsa.privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
      vaultAccountId: "42",
      assetId,
      apiBaseUrl: "https://fireblocks.example.test",
      useProgramCall: true,
    });
    const signer = await adapter.getTransactionSigner("fb_42");
    const [signatures] = await signer.signTransactions([transaction]);
    assert.deepEqual(Buffer.from(signatures[publicKey]), expectedSignature);
    assert.equal(
      requests.length,
      3,
      "One address read, one proposal and one signature poll; no broadcast"
    );
    assert.deepEqual(
      requests.map(({ url, init }) => `${init?.method} ${url}`),
      [
        `GET https://fireblocks.example.test/v1/vault/accounts/42/${assetId}/addresses_paginated`,
        "POST https://fireblocks.example.test/v1/transactions",
        "GET https://fireblocks.example.test/v1/transactions/proposal",
      ]
    );
    for (const { init } of requests)
      assert.equal(new Headers(init?.headers).get("X-API-Key"), "tenant-key");
    const body = requests[1].init?.body;
    assert(typeof body === "string");
    const proposal = proposalSchema.parse(JSON.parse(body));
    assert.equal(proposal.assetId, assetId);
    assert.equal(
      proposal.extraParameters.programCallData,
      getBase64EncodedWireTransaction(transaction)
    );
    const decoded = getTransactionDecoder().decode(
      Buffer.from(proposal.extraParameters.programCallData, "base64")
    );
    assert.deepEqual(Buffer.from(decoded.messageBytes), Buffer.from(transaction.messageBytes));
    assert.equal("signAndSendTransactions" in signer, false);
  } finally {
    globalThis.fetch = previousFetch;
  }
}
