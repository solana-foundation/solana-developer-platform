/**
 * Persistent Private Channels devnet canary.
 *
 * One serialized test proves the complete value path against real infrastructure:
 * auth + wallet verification, devnet deposit, private channel transfer, then a
 * channel burn and devnet withdrawal release. It is secret-gated and skipped in
 * ordinary local/CI runs.
 */

import {
  createAuthClient,
  createChannelGatewayRpc,
  getChannelTokenBalance,
  PrivateChannelError,
  spcLogin,
  spcRegister,
} from "@sdp/private-channels";
import * as solanaRpc from "@sdp/rpc/solana";
import { getDepositInstructionAsync } from "@sdp/spc-escrow";
import { getWithdrawFundsInstructionAsync } from "@sdp/spc-withdraw";
import { getBase58Codec, getBase58Decoder } from "@solana/codecs";
import {
  type Address,
  address,
  appendTransactionMessageInstructions,
  createKeyPairSignerFromBytes,
  createSignableMessage,
  createTransactionMessage,
  getTransactionEncoder,
  pipe,
  setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash,
  signTransactionMessageWithSigners,
  type TransactionSigner,
} from "@solana/kit";
import {
  findAssociatedTokenPda,
  getCreateAssociatedTokenIdempotentInstruction,
  getTransferInstruction,
  TOKEN_PROGRAM_ADDRESS,
} from "@solana-program/token";
import { describe, expect, it } from "vitest";
import { env } from "#env-impl";
import {
  getAuthPassword,
  getAuthUrl,
  getAuthUsername,
  getChainRpcUrl,
  getDepositAmountBaseUnits,
  getDepositSecretKey,
  getEscrowInstanceId,
  getGatewayUrl,
  getRecipientSecretKey,
  PRIVATE_CHANNEL_FULL_FLOW_CONFIGURED,
  RUN_INTEGRATION_TESTS,
} from "../helpers/private-channels";

const INSTANCE = PRIVATE_CHANNEL_FULL_FLOW_CONFIGURED
  ? address(getEscrowInstanceId())
  : address("11111111111111111111111111111111");
const DEVNET_USDC = address("4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU");

function decodeSecretKey(raw: string): Uint8Array {
  const trimmed = raw.trim();
  let decoded: Uint8Array;
  if (trimmed.startsWith("[")) {
    const parsed = JSON.parse(trimmed) as unknown;
    if (
      !Array.isArray(parsed) ||
      parsed.length !== 64 ||
      parsed.some((value) => !Number.isInteger(value) || value < 0 || value > 255)
    ) {
      throw new Error("Private Channels canary keypair must contain exactly 64 bytes");
    }
    decoded = Uint8Array.from(parsed as number[]);
  } else {
    decoded = new Uint8Array(getBase58Codec().encode(trimmed));
  }
  if (decoded.length !== 64) {
    throw new Error("Private Channels canary keypair must contain exactly 64 bytes");
  }
  return decoded;
}

async function readAmount(
  rpc: ReturnType<typeof createChannelGatewayRpc>,
  owner: Address
): Promise<bigint> {
  const { balance } = await getChannelTokenBalance(rpc, owner, DEVNET_USDC);
  return balance ? BigInt(balance.amount) : 0n;
}

async function waitForAmount(
  read: () => Promise<bigint>,
  predicate: (amount: bigint) => boolean,
  timeoutMs: number
): Promise<bigint> {
  const deadline = Date.now() + timeoutMs;
  let amount = await read();
  while (!predicate(amount) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 2_000));
    amount = await read();
  }
  return amount;
}

async function sendAndConfirm(
  rpc: ReturnType<typeof createChannelGatewayRpc>,
  signer: TransactionSigner,
  instructions: Parameters<typeof appendTransactionMessageInstructions>[0],
  timeoutMs = 60_000
) {
  const { blockhash, lastValidBlockHeight } = await solanaRpc.getRecentBlockhash(rpc, "confirmed");
  const message = pipe(
    createTransactionMessage({ version: 0 }),
    (m) => setTransactionMessageFeePayerSigner(signer, m),
    (m) => setTransactionMessageLifetimeUsingBlockhash({ blockhash, lastValidBlockHeight }, m),
    (m) => appendTransactionMessageInstructions(instructions, m)
  );
  const signed = await signTransactionMessageWithSigners(message);
  const signature = await solanaRpc.sendTransaction(
    rpc,
    new Uint8Array(getTransactionEncoder().encode(signed))
  );
  const confirmation = await solanaRpc.confirmTransaction(rpc, signature, {
    commitment: "confirmed",
    timeoutMs,
    pollIntervalMs: 500,
  });
  expect(confirmation.err).toBeFalsy();
  return signature;
}

async function loginOrRegister(): Promise<string> {
  const input = { username: getAuthUsername(), password: getAuthPassword() };
  try {
    return (await spcLogin(getAuthUrl(), input)).token;
  } catch (loginError) {
    try {
      await spcRegister(getAuthUrl(), input);
    } catch (registerError) {
      if (!(registerError instanceof PrivateChannelError) || registerError.code !== "CONFLICT") {
        throw registerError;
      }
    }
    try {
      return (await spcLogin(getAuthUrl(), input)).token;
    } catch {
      throw loginError;
    }
  }
}

async function verifyWallet(
  token: string,
  signer: Awaited<ReturnType<typeof createKeyPairSignerFromBytes>>
) {
  const client = createAuthClient(getAuthUrl());
  const challenge = await client.challengeWallet(token);
  const [signatures] = await signer.signMessages([createSignableMessage(challenge.message)]);
  const signatureBytes = signatures[signer.address];
  if (!signatureBytes) throw new Error(`Wallet ${signer.address} did not produce a signature`);
  try {
    await client.verifyWallet(token, {
      pubkey: signer.address,
      nonce: challenge.nonce,
      signature: getBase58Decoder().decode(signatureBytes),
    });
  } catch (error) {
    if (!(error instanceof PrivateChannelError) || error.code !== "CONFLICT") throw error;
  }
}

describe.skipIf(!PRIVATE_CHANNEL_FULL_FLOW_CONFIGURED || !RUN_INTEGRATION_TESTS)(
  "Private Channels full-flow canary",
  () => {
    it("deposits, privately transfers, and withdraws devnet USDC", async () => {
      const sender = await createKeyPairSignerFromBytes(decodeSecretKey(getDepositSecretKey()));
      const recipient = await createKeyPairSignerFromBytes(
        decodeSecretKey(getRecipientSecretKey())
      );
      expect(recipient.address).not.toBe(sender.address);

      const token = await loginOrRegister();
      await verifyWallet(token, sender);
      await verifyWallet(token, recipient);

      const gatewayRpc = createChannelGatewayRpc(env, getGatewayUrl(), {
        headers: { Authorization: `Bearer ${token}` },
      });
      const chainRpc = solanaRpc.createRpc(env, { rpcUrl: getChainRpcUrl() });
      const depositAmount = getDepositAmountBaseUnits();
      const transferAmount = depositAmount / 2n;
      const withdrawalAmount = transferAmount / 2n;
      expect(withdrawalAmount).toBeGreaterThan(0n);

      const senderBefore = await readAmount(gatewayRpc, sender.address);
      const recipientBefore = await readAmount(gatewayRpc, recipient.address);
      const recipientDevnetBefore = await readAmount(chainRpc, recipient.address);

      const depositIx = await getDepositInstructionAsync({
        payer: sender,
        user: sender,
        instance: INSTANCE,
        mint: DEVNET_USDC,
        amount: depositAmount,
        recipient: sender.address,
      });
      await sendAndConfirm(chainRpc, sender, [depositIx]);
      const senderCredited = await waitForAmount(
        () => readAmount(gatewayRpc, sender.address),
        (amount) => amount >= senderBefore + depositAmount,
        90_000
      );
      expect(senderCredited).toBeGreaterThanOrEqual(senderBefore + depositAmount);

      const [senderAta] = await findAssociatedTokenPda({
        owner: sender.address,
        mint: DEVNET_USDC,
        tokenProgram: TOKEN_PROGRAM_ADDRESS,
      });
      const [recipientAta] = await findAssociatedTokenPda({
        owner: recipient.address,
        mint: DEVNET_USDC,
        tokenProgram: TOKEN_PROGRAM_ADDRESS,
      });
      await sendAndConfirm(
        gatewayRpc,
        sender,
        [
          getCreateAssociatedTokenIdempotentInstruction({
            payer: sender,
            ata: recipientAta,
            owner: recipient.address,
            mint: DEVNET_USDC,
            tokenProgram: TOKEN_PROGRAM_ADDRESS,
          }),
          getTransferInstruction({
            source: senderAta,
            destination: recipientAta,
            authority: sender,
            amount: transferAmount,
          }),
        ],
        10_000
      );
      const recipientCredited = await waitForAmount(
        () => readAmount(gatewayRpc, recipient.address),
        (amount) => amount >= recipientBefore + transferAmount,
        10_000
      );
      expect(recipientCredited).toBeGreaterThanOrEqual(recipientBefore + transferAmount);

      const withdrawIx = await getWithdrawFundsInstructionAsync({
        user: recipient,
        mint: DEVNET_USDC,
        tokenProgram: TOKEN_PROGRAM_ADDRESS,
        amount: withdrawalAmount,
        destination: recipient.address,
      });
      await sendAndConfirm(gatewayRpc, recipient, [withdrawIx], 10_000);

      const recipientDebited = await waitForAmount(
        () => readAmount(gatewayRpc, recipient.address),
        (amount) => amount <= recipientCredited - withdrawalAmount,
        10_000
      );
      expect(recipientDebited).toBeLessThanOrEqual(recipientCredited - withdrawalAmount);

      const recipientReleased = await waitForAmount(
        () => readAmount(chainRpc, recipient.address),
        (amount) => amount >= recipientDevnetBefore + withdrawalAmount,
        180_000
      );
      expect(recipientReleased).toBeGreaterThanOrEqual(recipientDevnetBefore + withdrawalAmount);
    }, 330_000);
  }
);
