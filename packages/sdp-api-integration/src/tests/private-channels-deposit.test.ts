/**
 * Solana Private Channels (SPC) — live devnet deposit.
 *
 * Proves the generated escrow `deposit` instruction is correct against the REAL
 * devnet deployment: build it with `@sdp/spc-escrow`, sign with a funded devnet
 * keypair (payer + user), broadcast to devnet, confirm, then assert the operator
 * credits the channel (read via the gateway). App-free — no SDP app harness.
 *
 * Gated behind a funded keypair; skips otherwise. Run:
 *   RUN_INTEGRATION_TESTS=true \
 *   PRIVATE_CHANNEL_GATEWAY_URL=http://34.71.147.163:8899 \
 *   PRIVATE_CHANNEL_CHAIN_RPC_URL=https://devnet.helius-rpc.com/?api-key=… \
 *   PRIVATE_CHANNEL_DEPOSIT_SECRET_KEY='[12,34,…]' \
 *     pnpm --filter @sdp/api-integration test
 */

import { createChannelGatewayRpc, getChannelTokenBalance } from "@sdp/private-channels";
import * as solanaRpc from "@sdp/rpc/solana";
import { getDepositInstructionAsync } from "@sdp/spc-escrow";
import { getBase58Codec } from "@solana/codecs";
import {
  address,
  appendTransactionMessageInstructions,
  createKeyPairSignerFromBytes,
  createTransactionMessage,
  getTransactionEncoder,
  pipe,
  setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash,
  signTransactionMessageWithSigners,
} from "@solana/kit";
import { describe, expect, it } from "vitest";
import { env } from "#env-impl";
import {
  getChainRpcUrl,
  getDepositAmountBaseUnits,
  getDepositSecretKey,
  getGatewayUrl,
  PRIVATE_CHANNEL_DEPOSIT_CONFIGURED,
  RUN_INTEGRATION_TESTS,
} from "../helpers/private-channels";

// Sandbox instance + devnet USDC (classic Token program).
const INSTANCE = address("7C1Pu8mbHaDDTFnGH8YTqemNDofqXP3XEotzSo6TbwHz");
const DEVNET_USDC = address("4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU");

/** Accepts a Solana CLI keypair JSON array (`[..64..]`) or a base58 secret. */
function decodeSecretKey(raw: string): Uint8Array {
  const trimmed = raw.trim();
  if (trimmed.startsWith("[")) {
    return Uint8Array.from(JSON.parse(trimmed) as number[]);
  }
  // getBase58Codec().encode returns a ReadonlyUint8Array; copy into a mutable one.
  return new Uint8Array(getBase58Codec().encode(trimmed));
}

async function readChannelAmount(
  gatewayRpc: ReturnType<typeof createChannelGatewayRpc>,
  owner: ReturnType<typeof address>,
  mint: ReturnType<typeof address>
): Promise<bigint> {
  const { balance } = await getChannelTokenBalance(gatewayRpc, owner, mint);
  return balance ? BigInt(balance.amount) : 0n;
}

describe.skipIf(!PRIVATE_CHANNEL_DEPOSIT_CONFIGURED || !RUN_INTEGRATION_TESTS)(
  "Private Channels deposit",
  () => {
    it("deposits into the escrow on devnet and credits the channel", async () => {
      const signer = await createKeyPairSignerFromBytes(decodeSecretKey(getDepositSecretKey()));
      const owner = signer.address;
      const amount = getDepositAmountBaseUnits();

      const gatewayRpc = createChannelGatewayRpc(env, getGatewayUrl());
      const baseline = await readChannelAmount(gatewayRpc, owner, DEVNET_USDC);

      // Build the escrow deposit (payer + user are the same funded keypair).
      const depositIx = await getDepositInstructionAsync({
        payer: signer,
        user: signer,
        instance: INSTANCE,
        mint: DEVNET_USDC,
        amount,
        recipient: owner,
      });

      // Sign + broadcast + confirm on the instance chain (devnet).
      const chainRpc = solanaRpc.createRpc(env, { rpcUrl: getChainRpcUrl() });
      const { blockhash, lastValidBlockHeight } = await solanaRpc.getRecentBlockhash(
        chainRpc,
        "confirmed"
      );
      const message = pipe(
        createTransactionMessage({ version: 0 }),
        (m) => setTransactionMessageFeePayerSigner(signer, m),
        (m) => setTransactionMessageLifetimeUsingBlockhash({ blockhash, lastValidBlockHeight }, m),
        (m) => appendTransactionMessageInstructions([depositIx], m)
      );
      const signed = await signTransactionMessageWithSigners(message);
      const signedBytes = new Uint8Array(getTransactionEncoder().encode(signed));

      const signature = await solanaRpc.sendTransaction(chainRpc, signedBytes);
      const confirmation = await solanaRpc.confirmTransaction(chainRpc, signature, {
        commitment: "confirmed",
      });
      expect(confirmation.err).toBeFalsy();

      // The operator credits the channel within seconds — poll the gateway.
      const target = baseline + amount;
      const deadline = Date.now() + 90_000;
      let credited = baseline;
      while (Date.now() < deadline) {
        credited = await readChannelAmount(gatewayRpc, owner, DEVNET_USDC);
        if (credited >= target) {
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 2_000));
      }
      expect(credited).toBeGreaterThanOrEqual(target);
    }, 120_000);
  }
);
