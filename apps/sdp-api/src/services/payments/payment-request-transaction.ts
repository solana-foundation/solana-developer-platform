import { createClusterRpc } from "@sdp/rpc/factory";
import { getRecentBlockhash } from "@sdp/rpc/solana";
import { assertValidAddress } from "@sdp/solana/address";
import { parseDecimalAmount } from "@sdp/solana/amount";
import { SOL_DECIMALS, SOL_MINT } from "@sdp/types/well-known-tokens";
import {
  type AccountMeta,
  AccountRole,
  type Address,
  appendTransactionMessageInstructions,
  compileTransaction,
  createNoopSigner,
  createTransactionMessage,
  getBase64Decoder,
  getTransactionEncoder,
  type Instruction,
  pipe,
  setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash,
} from "@solana/kit";
import { getTransferSolInstruction } from "@solana-program/system";
import type { PaymentRequestRow } from "@/db/repositories/payment-requests.repository";
import { badRequest } from "@/lib/errors";
import { buildSplTransferInstructions } from "@/routes/payments/token-accounts";

/**
 * Compile the unsigned transfer a payer signs to settle a payment request. The payer is the fee
 * payer and pays any missing destination token account's rent, so SDP signs nothing. The
 * blockhash comes from the open cluster scope, the request's own cluster: a wallet on another
 * cluster cannot land it, so a devnet request never spends mainnet funds.
 *
 * @param params - The request and who pays it.
 * @param params.request - The payment request: destination, token, amount and reference.
 * @param params.payer - The account that pays the transfer and its fees, and signs client-side.
 * @returns The compiled, unsigned transaction as base64.
 * @throws AppError `BAD_REQUEST` when the amount is not positive in the token's base units.
 */
export async function buildPaymentRequestTransaction(params: {
  request: PaymentRequestRow;
  payer: Address;
}): Promise<string> {
  const { request, payer } = params;
  const rpc = createClusterRpc();
  const recipient = assertValidAddress(request.destination_address, "destinationAddress");
  const reference = assertValidAddress(request.reference, "reference");
  const withReference = (instruction: Instruction & { accounts: readonly AccountMeta[] }) => ({
    ...instruction,
    accounts: [...instruction.accounts, { address: reference, role: AccountRole.READONLY }],
  });
  const payerSigner = createNoopSigner(payer);

  let instructions: Instruction[];
  if (request.token === SOL_MINT) {
    const lamports = parseDecimalAmount(request.amount, SOL_DECIMALS);
    if (lamports <= 0n) {
      throw badRequest("Transfer amount must be greater than zero");
    }
    instructions = [
      withReference(
        getTransferSolInstruction({ source: payerSigner, destination: recipient, amount: lamports })
      ),
    ];
  } else {
    const { createDestinationAtaInstruction, transferInstruction } =
      await buildSplTransferInstructions(rpc, {
        authority: payerSigner,
        destination: recipient,
        mint: assertValidAddress(request.token, "token"),
        amount: request.amount,
        ataRentPayer: payer,
      });
    instructions = [createDestinationAtaInstruction, withReference(transferInstruction)];
  }

  const lifetime = await getRecentBlockhash(rpc, "confirmed");
  const message = pipe(
    createTransactionMessage({ version: 0 }),
    (m) => setTransactionMessageFeePayer(payer, m),
    (m) => setTransactionMessageLifetimeUsingBlockhash(lifetime, m),
    (m) => appendTransactionMessageInstructions(instructions, m)
  );
  const txBytes = new Uint8Array(getTransactionEncoder().encode(compileTransaction(message)));
  return getBase64Decoder().decode(txBytes);
}
