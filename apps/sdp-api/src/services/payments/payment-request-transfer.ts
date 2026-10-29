import { createClusterRpc } from "@sdp/rpc/factory";
import {
  type Address,
  decodeTransactionFromRpcResponse,
  getAccountMetasFromCompiledTransactionMessage,
  getInstructionsFromCompiledTransactionMessage,
  type Signature,
  type TokenBalance,
} from "@solana/kit";
import { ValidateTransferError } from "@solana/pay";
import {
  identifySystemInstruction,
  parseTransferSolInstruction,
  SYSTEM_PROGRAM_ADDRESS,
  SystemInstruction,
} from "@solana-program/system";
import {
  findAssociatedTokenPda,
  identifyTokenInstruction,
  parseTransferCheckedInstruction,
  parseTransferInstruction,
  TokenInstruction,
} from "@solana-program/token";

export interface PaymentRequestTransferFields {
  recipient: Address;
  amount: bigint;
  decimals: number;
  tokenProgram: Address;
  reference: Address;
  splToken?: Address;
}

/**
 * Validates the referenced transfer and its exact recipient balance increase in one read. Accounts
 * resolve through the transaction's loaded lookup-table addresses, in the runtime's order, so a
 * version-0 payment naming its recipient through a lookup table settles like a static one.
 *
 * @param signature - The transaction that carries the payment request's reference.
 * @param fields - The request's recipient, exact base-unit amount, mint facts and reference.
 * @returns The finalized transaction response the transfer was validated against.
 * @throws ValidateTransferError when the transaction fails, or its last instruction is not the
 *   expected transfer, or the recipient received less than the amount.
 */
export async function validatePaymentRequestTransfer(
  signature: Signature,
  fields: PaymentRequestTransferFields
) {
  const response = await createClusterRpc()
    .getTransaction(signature, {
      commitment: "finalized",
      maxSupportedTransactionVersion: 0,
      encoding: "base64",
    })
    .send();
  if (response === null) {
    throw new ValidateTransferError("Transaction not found");
  }
  if (response.meta === null) {
    throw new ValidateTransferError("Transaction meta missing");
  }
  if (response.meta.err !== null) {
    throw new ValidateTransferError("Transaction failed");
  }
  const { compiledMessage, loadedAddresses } = decodeTransactionFromRpcResponse(response);
  const candidate = getInstructionsFromCompiledTransactionMessage(
    compiledMessage,
    loadedAddresses
  ).at(-1);
  if (candidate === undefined || candidate.accounts === undefined || candidate.data === undefined) {
    throw new ValidateTransferError("Missing transfer instruction");
  }
  const instruction = { ...candidate, accounts: candidate.accounts, data: candidate.data };
  let recipientAccount: Address;
  let requiredAccounts: number;
  if (fields.splToken === undefined) {
    if (
      instruction.programAddress !== SYSTEM_PROGRAM_ADDRESS ||
      identifySystemInstruction(instruction) !== SystemInstruction.TransferSol
    ) {
      throw new ValidateTransferError("Invalid SOL transfer");
    }
    const parsed = parseTransferSolInstruction(instruction);
    if (parsed.accounts.destination.address !== fields.recipient)
      throw new ValidateTransferError("Wrong recipient");
    recipientAccount = fields.recipient;
    requiredAccounts = Object.keys(parsed.accounts).length;
  } else {
    if (instruction.programAddress !== fields.tokenProgram)
      throw new ValidateTransferError("Wrong token program");
    [recipientAccount] = await findAssociatedTokenPda({
      owner: fields.recipient,
      mint: fields.splToken,
      tokenProgram: fields.tokenProgram,
    });
    switch (identifyTokenInstruction(instruction)) {
      case TokenInstruction.TransferChecked: {
        const parsed = parseTransferCheckedInstruction(instruction);
        if (
          parsed.accounts.destination.address !== recipientAccount ||
          parsed.accounts.mint.address !== fields.splToken ||
          parsed.data.decimals !== fields.decimals
        )
          throw new ValidateTransferError("Wrong token transfer");
        requiredAccounts = Object.keys(parsed.accounts).length;
        break;
      }
      case TokenInstruction.Transfer: {
        const parsed = parseTransferInstruction(instruction);
        if (parsed.accounts.destination.address !== recipientAccount)
          throw new ValidateTransferError("Wrong token recipient");
        requiredAccounts = Object.keys(parsed.accounts).length;
        break;
      }
      default:
        throw new ValidateTransferError("Invalid token transfer instruction");
    }
  }
  if (
    instruction.accounts.length !== requiredAccounts + 1 ||
    instruction.accounts[requiredAccounts].address !== fields.reference
  ) {
    throw new ValidateTransferError("Wrong payment reference");
  }
  const accountIndex = getAccountMetasFromCompiledTransactionMessage(
    compiledMessage,
    loadedAddresses
  ).findIndex((account) => account.address === recipientAccount);
  if (accountIndex === -1) throw new ValidateTransferError("Missing recipient account");
  validateReceivedAmount(response.meta, accountIndex, fields);
  return response;
}

/** A new ATA contributes zero pre-balance, but only a matching post-balance proves receipt. */
function validateReceivedAmount(
  meta: {
    preBalances: readonly bigint[];
    postBalances: readonly bigint[];
    preTokenBalances?: readonly TokenBalance[];
    postTokenBalances?: readonly TokenBalance[];
  },
  accountIndex: number,
  fields: PaymentRequestTransferFields
): void {
  let received: bigint;
  if (fields.splToken === undefined) {
    const pre = meta.preBalances[accountIndex];
    const post = meta.postBalances[accountIndex];
    if (pre === undefined || post === undefined)
      throw new ValidateTransferError("Missing SOL balance data");
    received = post - pre;
  } else {
    const pre = meta.preTokenBalances?.find((balance) => balance.accountIndex === accountIndex);
    const post = meta.postTokenBalances?.find((balance) => balance.accountIndex === accountIndex);
    if (
      post === undefined ||
      post.mint !== fields.splToken ||
      post.uiTokenAmount.decimals !== fields.decimals ||
      (pre !== undefined &&
        (pre.mint !== fields.splToken || pre.uiTokenAmount.decimals !== fields.decimals))
    ) {
      throw new ValidateTransferError("Missing or mismatched token balance data");
    }
    // Newly created ATAs have no pre-token balance; the matching post entry is required.
    received =
      BigInt(post.uiTokenAmount.amount) -
      (pre === undefined ? 0n : BigInt(pre.uiTokenAmount.amount));
  }
  if (received < fields.amount) throw new ValidateTransferError("Amount not transferred");
}
