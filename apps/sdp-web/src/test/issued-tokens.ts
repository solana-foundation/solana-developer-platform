import type { PaymentsIssuedTokenSymbol } from "@/app/(session)/dashboard/[projectId]/payments/payments-page.data";

/** A project's issued mint: a valid address outside the well-known token list. */
export const ISSUED_TOKEN_MINT = "BmA22WnK8p5Ai5mkzJhk64DCxMiUiii69tgSmUGMWPSh";

/** That mint as the Issuance token listing returns it. */
export const ISSUED_TOKEN: PaymentsIssuedTokenSymbol = {
  id: "tok_issued",
  mintAddress: ISSUED_TOKEN_MINT,
  symbol: "ACME",
  imageUrl: null,
};
