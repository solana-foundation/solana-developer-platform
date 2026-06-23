import type { Address } from "@solana/kit";
import { getSignaturesForAddress, type Signature, type SignatureInfo, type SolanaRpc } from "./rpc";

export interface SolanaPayTransferRequest {
  recipient: Address;
  amount: string;
  splToken: Address;
  reference: Address;
  label?: string;
  message?: string;
}

export function encodeSolanaPayURL(request: SolanaPayTransferRequest): string {
  const params = new URLSearchParams();
  params.set("amount", request.amount);
  params.set("spl-token", request.splToken);
  params.append("reference", request.reference);
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
    throw new Error(`Transaction ${signature} not found`);
  }
  if (!response.meta) {
    throw new Error(`Transaction ${signature} has no metadata`);
  }
  if (response.meta.err) {
    return { valid: false, received: 0n };
  }

  const sumForRecipient = (balances: RpcTokenBalance[]): bigint =>
    balances
      .filter((balance) => balance.owner === params.recipient && balance.mint === params.splToken)
      .reduce((total, balance) => total + BigInt(balance.uiTokenAmount.amount), 0n);

  const received =
    sumForRecipient(response.meta.postTokenBalances) -
    sumForRecipient(response.meta.preTokenBalances);

  return { valid: received >= params.amount, received };
}
