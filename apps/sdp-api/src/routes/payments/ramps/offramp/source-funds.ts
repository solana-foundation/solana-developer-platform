import { createClusterRpc } from "@sdp/rpc/factory";
import { AmountError, formatDecimalAmount, parseDecimalAmount } from "@sdp/solana/amount";
import { SOL_DECIMALS, SOL_MINT, WELL_KNOWN_TOKEN_BY_MINT } from "@sdp/types/well-known-tokens";
import { address } from "@solana/kit";
import { AppError, accountFrozen, badRequest } from "@/lib/errors";

interface SourceHolding {
  amount: bigint;
  frozen: boolean;
}

/**
 * What the wallet holds of `mint`, in one RPC read: its SOL balance, or its
 * largest token account for the mint, since a deposit sends from one account.
 */
async function readSourceHolding(owner: string, mint: string): Promise<SourceHolding> {
  const rpc = createClusterRpc();
  if (mint === SOL_MINT) {
    const { value } = await rpc.getBalance(address(owner), { commitment: "confirmed" }).send();
    return { amount: value, frozen: false };
  }
  const { value } = await rpc
    .getTokenAccountsByOwner(
      address(owner),
      { mint: address(mint) },
      { encoding: "jsonParsed", commitment: "confirmed" }
    )
    .send();
  let holding: SourceHolding = { amount: 0n, frozen: false };
  for (const account of value) {
    const info = account.account.data.parsed.info;
    const amount = BigInt(info.tokenAmount.amount);
    if (amount > holding.amount) holding = { amount, frozen: info.state === "frozen" };
  }
  return holding;
}

/**
 * Refuses an off-ramp sale the source wallet cannot fund. SDP sends the
 * sale's deposit from this wallet, so an unfunded sale would only fail there.
 *
 * @param owner - The source wallet's address.
 * @param mint - The mint the sale sells.
 * @param cryptoAmount - The amount the sale sells, in display units.
 */
export async function assertOfframpSourceFunded(
  owner: string,
  mint: string,
  cryptoAmount: string
): Promise<void> {
  const token = WELL_KNOWN_TOKEN_BY_MINT.get(mint);
  const decimals = mint === SOL_MINT ? SOL_DECIMALS : token?.decimals;
  if (decimals === undefined) {
    throw badRequest("Off-ramp asset is not a well-known token");
  }
  const symbol = token?.symbol ?? "SOL";
  let needed: bigint;
  try {
    needed = parseDecimalAmount(cryptoAmount, decimals);
  } catch (cause) {
    // The schema checks the shape; only the asset knows its precision.
    if (cause instanceof AmountError) {
      throw badRequest(`${cause.message}: ${symbol} allows ${decimals}`);
    }
    throw cause;
  }
  const holding = await readSourceHolding(owner, mint);
  if (holding.frozen) {
    throw accountFrozen(`Source wallet's ${symbol} account is frozen`);
  }
  if (holding.amount >= needed) return;
  const held = formatDecimalAmount(holding.amount, decimals);
  const neededAmount = formatDecimalAmount(needed, decimals);
  throw new AppError(
    "INSUFFICIENT_TOKEN_BALANCE",
    `Source wallet holds ${held} ${symbol}; this sale needs ${neededAmount} ${symbol}`,
    { held, needed: neededAmount }
  );
}
