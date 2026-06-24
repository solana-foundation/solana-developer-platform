import type { Address } from "@solana/kit";
import { parseDecimalAmount } from "@/lib/amount";
import { internalError } from "@/lib/errors";
import { getSignaturesForAddress, type Signature, type SignatureInfo, type SolanaRpc } from "./rpc";

export interface SolanaPayTransferRequest {
  recipient: Address;
  amount: string;
  splToken: Address;
  reference: Address;
  memo: string;
  label?: string;
  message?: string;
}

export function encodeSolanaPayURL(request: SolanaPayTransferRequest): string {
  const params = new URLSearchParams();
  params.set("amount", request.amount);
  params.set("spl-token", request.splToken);
  params.append("reference", request.reference);
  params.set("memo", request.memo);
  if (request.label) {
    params.set("label", request.label);
  }
  if (request.message) {
    params.set("message", request.message);
  }
  return `solana:${request.recipient}?${params.toString().replace(/\+/g, "%20")}`;
}

export async function findReference(
  rpc: SolanaRpc,
  reference: Address
): Promise<SignatureInfo | null> {
  const signatures = await getSignaturesForAddress(rpc, reference);
  if (signatures.length === 0) {
    return null;
  }
  return signatures[signatures.length - 1];
}

export interface ValidateTransferParams {
  recipient: Address;
  splToken: Address;
  amount: bigint;
}

export interface TransferValidation {
  valid: boolean;
  /**
   * Net recipient balance delta in raw base units. Normally positive, but is
   * negative when the recipient is net-debited within the same transaction. Not
   * clamped — callers see the true on-chain delta, and `valid` already accounts
   * for it (`received >= amount` is false for any negative delta).
   */
  received: bigint;
}

interface RpcTokenBalance {
  mint: string;
  owner: string;
  uiTokenAmount: { amount: string };
}

interface RpcTransactionForValidation {
  meta: {
    err: unknown | null;
    preTokenBalances: RpcTokenBalance[];
    postTokenBalances: RpcTokenBalance[];
  } | null;
}

export async function validateTransfer(
  rpc: SolanaRpc,
  signature: Signature,
  params: ValidateTransferParams
): Promise<TransferValidation> {
  const response = (await rpc
    .getTransaction(signature, {
      commitment: "confirmed",
      encoding: "jsonParsed",
      maxSupportedTransactionVersion: 0,
    })
    .send()) as RpcTransactionForValidation | null;

  if (!response) {
    throw internalError(`Transaction ${signature} not found`);
  }
  if (!response.meta) {
    throw internalError(`Transaction ${signature} has no metadata`);
  }
  if (response.meta.err) {
    return { valid: false, received: 0n };
  }

  const sumForRecipient = (balances: RpcTokenBalance[]): bigint =>
    balances
      .filter((balance) => balance.owner === params.recipient && balance.mint === params.splToken)
      .reduce((total, balance) => total + parseDecimalAmount(balance.uiTokenAmount.amount, 0), 0n);

  const received =
    sumForRecipient(response.meta.postTokenBalances) -
    sumForRecipient(response.meta.preTokenBalances);

  return { valid: received >= params.amount, received };
}

export interface ValidateNativeTransferParams {
  recipient: Address;
  amount: bigint;
}

interface RpcNativeTransactionForValidation {
  meta: {
    err: unknown | null;
    preBalances: number[];
    postBalances: number[];
  } | null;
  transaction: {
    message: {
      accountKeys: Array<{ pubkey: string }>;
    };
  };
}

/**
 * Native-SOL counterpart of `validateTransfer`. SOL moves as lamports, not SPL
 * token balances, so the recipient's delta comes from pre/postBalances indexed
 * by the recipient's position in the message account keys.
 */
export async function validateNativeTransfer(
  rpc: SolanaRpc,
  signature: Signature,
  params: ValidateNativeTransferParams
): Promise<TransferValidation> {
  const response = (await rpc
    .getTransaction(signature, {
      commitment: "confirmed",
      encoding: "jsonParsed",
      maxSupportedTransactionVersion: 0,
    })
    .send()) as RpcNativeTransactionForValidation | null;

  if (!response) {
    throw internalError(`Transaction ${signature} not found`);
  }
  if (!response.meta) {
    throw internalError(`Transaction ${signature} has no metadata`);
  }
  if (response.meta.err) {
    return { valid: false, received: 0n };
  }

  const index = response.transaction.message.accountKeys.findIndex(
    (key) => key.pubkey === params.recipient
  );
  if (index === -1) {
    return { valid: false, received: 0n };
  }

  const received =
    BigInt(response.meta.postBalances[index]) - BigInt(response.meta.preBalances[index]);
  return { valid: received >= params.amount, received };
}
