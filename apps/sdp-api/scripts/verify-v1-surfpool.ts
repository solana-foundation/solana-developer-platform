import { getSponsoredTransaction } from "@sdp/fee-payment/chain-reads";
import {
  confirmTransaction,
  getRecentBlockhash,
  getSignaturesForAddress,
  getTransaction,
  sendTransaction,
} from "@sdp/rpc/solana";
import { GENESIS_HASH_BY_CLUSTER } from "@sdp/types/well-known-tokens";
import {
  AccountRole,
  appendTransactionMessageInstructions,
  createSolanaRpc,
  createTransactionMessage,
  generateKeyPairSigner,
  getTransactionEncoder,
  lamports,
  pipe,
  setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash,
  signTransactionMessageWithSigners,
} from "@solana/kit";
import { getTransferSolInstruction, SYSTEM_PROGRAM_ADDRESS } from "@solana-program/system";
import { buildObservedTransfersForSignatures } from "@/routes/payments/transfers/observed-transfers";
import { runInEnvironmentClusterScope } from "@/runtime/cluster-scope-runs";
import { validatePaymentRequestTransfer } from "@/services/payments/payment-request-transfer";

const surfpoolUrl = process.env.SURFPOOL_RPC_URL;
if (!surfpoolUrl) throw new Error("SURFPOOL_RPC_URL is required");
const url = new URL(surfpoolUrl);
if (url.protocol !== "http:" || !["127.0.0.1", "localhost"].includes(url.hostname)) {
  throw new Error("The v1 smoke test only sends to a loopback Surfpool RPC");
}
process.env.SOLANA_RPC_DEFAULT_DEVNET_API_KEY_URL = url.toString();
process.env.KORA_DEVNET_RPC_URL = url.toString();

const rpc = createSolanaRpc(url.toString());
if ((await rpc.getGenesisHash().send()) !== GENESIS_HASH_BY_CLUSTER.devnet) {
  throw new Error("Surfpool must fork devnet for SDP's genesis guard");
}

const payer = await generateKeyPairSigner();
const recipient = await generateKeyPairSigner();
const reference = await generateKeyPairSigner();
const amount = 1_000_000n;
const airdrop = await rpc
  .requestAirdrop(payer.address, lamports(2_000_000_000n), { commitment: "confirmed" })
  .send();
await confirmTransaction(rpc, airdrop, {
  commitment: "finalized",
  timeoutMs: 30_000,
  pollIntervalMs: 250,
});

const { blockhash, lastValidBlockHeight } = await getRecentBlockhash(rpc, "confirmed");
const transfer = getTransferSolInstruction({
  source: payer,
  destination: recipient.address,
  amount: lamports(amount),
});
const referenced = {
  ...transfer,
  accounts: [...transfer.accounts, { address: reference.address, role: AccountRole.READONLY }],
};
const message = pipe(
  createTransactionMessage({ version: 0 }),
  (m) => setTransactionMessageFeePayerSigner(payer, m),
  (m) => setTransactionMessageLifetimeUsingBlockhash({ blockhash, lastValidBlockHeight }, m),
  (m) => appendTransactionMessageInstructions([referenced], m)
);
// Kit 7 signs v1 wire messages, although its message constructor only types v0.
const v1 = {
  ...message,
  version: 1 as const,
  config: { computeUnitLimit: 200_000, loadedAccountsDataSizeLimit: 65_536 },
};
const signed = await signTransactionMessageWithSigners(v1);
if (signed.messageBytes[0] !== 129) throw new Error("The signed wire message is not v1");
const signature = await sendTransaction(
  rpc,
  new Uint8Array(getTransactionEncoder().encode(signed))
);
const confirmation = await confirmTransaction(rpc, signature, {
  commitment: "finalized",
  timeoutMs: 30_000,
  pollIntervalMs: 250,
});
if (confirmation.err !== null) throw new Error("The v1 transfer failed");

const parsed = await getTransaction(rpc, signature, "finalized");
if (parsed?.fee !== 5_000n || parsed.postBalances[1] - parsed.preBalances[1] !== amount) {
  throw new Error("The shared transaction reader lost v1 balance data");
}
const observed = await runInEnvironmentClusterScope("sandbox", async () => {
  const validated = await validatePaymentRequestTransfer(signature, {
    recipient: recipient.address,
    amount,
    decimals: 9,
    tokenProgram: SYSTEM_PROGRAM_ADDRESS,
    reference: reference.address,
  });
  if (validated.version !== 1) throw new Error("Payment validation did not read v1");

  const history = await getSignaturesForAddress(rpc, recipient.address, {
    commitment: "finalized",
    limit: 10,
  });
  const rows = await buildObservedTransfersForSignatures(
    history.filter((entry) => entry.signature === signature),
    {
      organizationId: "org_local",
      projectId: "project_local",
      walletIdsByAddress: new Map([[recipient.address, "wallet_local"]]),
    }
  );
  if (
    !rows.some(
      (row) =>
        row.signature === signature &&
        row.direction === "inbound" &&
        row.destination_address === recipient.address
    )
  ) {
    throw new Error("The observed transfer list missed the inbound v1 payment");
  }

  const sponsored = await getSponsoredTransaction(signature);
  if (
    sponsored?.fee !== 5_000n ||
    sponsored.postBalances[1] - sponsored.preBalances[1] !== amount
  ) {
    throw new Error("The sponsorship upstream could not read the v1 transfer");
  }
  return rows;
});

console.log(
  JSON.stringify({
    signature,
    slot: String(confirmation.slot),
    version: 1,
    paymentValidated: true,
    observedInboundRows: observed.length,
    sponsorshipRead: true,
  })
);
