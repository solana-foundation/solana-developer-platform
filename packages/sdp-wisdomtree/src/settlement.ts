import { providerUnavailable } from "@sdp/earn/errors";
import {
  getWisdomTreeOrderByHash,
  WISDOMTREE_SOLANA_BLOCKCHAIN_KEY,
} from "@sdp/earn/providers/wisdomtree/connect";
import type {
  EarnProviderSettlementCandidate,
  EarnProviderSettlementInput,
  EarnRuntimeContext,
} from "@sdp/earn/types";
import { deriveAssociatedTokenAddress } from "@sdp/solana/address";
import { acceptTokenAmount, TokenAmountError } from "@sdp/solana/amount";
import {
  WISDOMTREE_ORDER_RECOVERY_STATUSES,
  WISDOMTREE_ORDER_SETTLED_STATUS,
} from "@sdp/types/earn-provider-orders";
import { SPL_TOKEN_PROGRAMS, wellKnownDecimals, wellKnownMint } from "@sdp/types/well-known-tokens";
import type { WisdomTreeFund } from "@sdp/types/wisdomtree-programs";
import { address, isSignature, signature } from "@solana/kit";

/** Read one accessible order; only the shared reconciler can verify actual delivery. */
export async function readWisdomTreeSettlement(
  ctx: EarnRuntimeContext,
  input: EarnProviderSettlementInput,
  fund: WisdomTreeFund,
  assertActive: () => void
): Promise<EarnProviderSettlementCandidate> {
  const owner = address(input.owner);
  const sourceSignature = signature(input.sourceSignature);
  const purchase = input.direction === "deposit";
  const usdc = wellKnownMint("USDC", fund.cluster);
  const usdcDecimals = wellKnownDecimals("USDC", fund.cluster);
  if (usdc === undefined || usdcDecimals === undefined)
    throw providerUnavailable("WisdomTree settlement has no USDC deployment");
  const tokenMint = purchase ? fund.mint : usdc;
  const programAddress = purchase
    ? SPL_TOKEN_PROGRAMS["token-2022"]
    : SPL_TOKEN_PROGRAMS["spl-token"];
  const candidate: EarnProviderSettlementCandidate = {
    sourceSignature,
    owner,
    destinationSignature: null,
    tokenMint,
    programAddress,
    requiredAccount: await deriveAssociatedTokenAddress(owner, tokenMint, programAddress),
    phase: "processing",
  };

  assertActive();
  const order = await getWisdomTreeOrderByHash(ctx, sourceSignature);
  assertActive();
  if (order === null) return candidate;
  const matchesSource = purchase
    ? order.conversion_order_hash === sourceSignature || order.deposit_hash === sourceSignature
    : order.deposit_hash === sourceSignature;
  if (
    !matchesSource ||
    order.settlement_wallet_address !== owner ||
    order.exchange_code !== fund.exchangeCode ||
    order.token_contract_address !== fund.mint ||
    order.trade_type !== (purchase ? "Purchase" : "Sale") ||
    order.blockchain !== WISDOMTREE_SOLANA_BLOCKCHAIN_KEY ||
    order.settlement_currency_name !== "USDC" ||
    (order.order_type !== undefined && order.order_type.toLowerCase() !== "primary")
  ) {
    throw providerUnavailable("WisdomTree order differs from its recorded settlement identity");
  }

  if (WISDOMTREE_ORDER_RECOVERY_STATUSES.some((status) => status === order.status))
    return { ...candidate, phase: "recovery_required" };
  // Even a token-delivered intermediate status is not the issuer's completed order.
  if (order.status !== WISDOMTREE_ORDER_SETTLED_STATUS) return candidate;
  const destination = purchase ? order.issuer_order_hash : order.conversion_order_hash;
  if (destination === undefined || destination === null || destination === "") return candidate;
  if (destination === sourceSignature || !isSignature(destination))
    throw providerUnavailable("WisdomTree returned an invalid destination settlement signature");

  // Cross-check the completed order's reported output; never book this as a receipt.
  // Incompatible or aggregated delivery stays unresolved rather than overstating it.
  const reportedOutput = purchase ? order.token_amount : order.net_value;
  if (reportedOutput === undefined || reportedOutput === null) return candidate;
  try {
    const output = acceptTokenAmount(reportedOutput, purchase ? fund.decimals : usdcDecimals, {
      positive: true,
    });
    return { ...candidate, destinationSignature: destination, expectedAmount: output.canonical };
  } catch (cause) {
    if (!(cause instanceof TokenAmountError)) throw cause;
    throw providerUnavailable("WisdomTree returned an unusable settled output amount");
  }
}
