import { getSponsoredTransaction } from "@sdp/fee-payment/chain-reads";
import { createClusterRpc } from "@sdp/rpc/factory";
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
import { z } from "zod";
import { buildObservedTransfersForSignatures } from "@/routes/payments/transfers/observed-transfers";
import { runInEnvironmentClusterScope } from "@/runtime/cluster-scope-runs";
import { requestDevnetFaucetAirdrop } from "@/services/custody/devnet-faucet";
import { validatePaymentRequestTransfer } from "@/services/payments/payment-request-transfer";

const { SURFPOOL_RPC_URL: surfpoolUrl } = z
  .object({
    SURFPOOL_RPC_URL: z
      .url()
      .transform((value) => new URL(value))
      .refine(
        (url) =>
          url.protocol === "http:" &&
          ["127.0.0.1", "localhost"].includes(url.hostname) &&
          url.username === "" &&
          url.password === "",
        "Surfpool RPC must be an unauthenticated loopback HTTP URL"
      ),
  })
  .parse(process.env);

// A developer may have other devnet providers in their shell. The smoke must
// send only to Surfpool while still using the same managed client as SDP.
for (const key of Object.keys(process.env)) {
  if (key.startsWith("SOLANA_RPC_") && key.endsWith("_DEVNET_API_KEY_URL")) {
    delete process.env[key];
  }
}
process.env.SOLANA_RPC_DEFAULT_DEVNET_API_KEY_URL = surfpoolUrl.toString();
process.env.KORA_DEVNET_RPC_URL = surfpoolUrl.toString();

await runInEnvironmentClusterScope("sandbox", async () => {
  const rpc = createClusterRpc();
  if ((await rpc.getGenesisHash().send()) !== GENESIS_HASH_BY_CLUSTER.devnet) {
    throw new Error("Surfpool must fork devnet for SDP's genesis guard");
  }

  const payer = await generateKeyPairSigner();
  const recipient = await generateKeyPairSigner();
  const reference = await generateKeyPairSigner();
  const amount = 1_000_000n;
  const airdrop = await requestDevnetFaucetAirdrop(payer.address);
  if (airdrop.status !== "confirmed") throw new Error("Surfpool airdrop did not confirm");

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
  if (
    parsed?.fee !== 5_000n ||
    parsed.preBalances === undefined ||
    parsed.postBalances === undefined ||
    parsed.postBalances[1] - parsed.preBalances[1] !== amount
  ) {
    throw new Error("The shared transaction reader lost v1 balance data");
  }
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
    sponsored.preBalances === undefined ||
    sponsored.postBalances === undefined ||
    sponsored.postBalances[1] - sponsored.preBalances[1] !== amount
  ) {
    throw new Error("The sponsorship upstream could not read the v1 transfer");
  }
  console.log(
    JSON.stringify({
      signature,
      slot: String(confirmation.slot),
      version: 1,
      paymentValidated: true,
      observedInboundRows: rows.length,
      sponsorshipRead: true,
    })
  );
});
