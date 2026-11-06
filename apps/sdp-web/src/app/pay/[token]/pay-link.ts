import { PAYMENT_REQUEST_STATUSES } from "@sdp/types/payments";
import { SOLANA_CLUSTERS } from "@sdp/types/well-known-tokens";
import { z } from "zod";

/**
 * The API's public read of a payment link (`GET /pay/:token`), parsed where it arrives: the page
 * draws it on the web server, and the status watch reads it again from the payer's browser.
 */
export const payLinkSchema = z.object({
  amount: z.string(),
  tokenSymbol: z.string(),
  recipient: z.string(),
  status: z.enum(PAYMENT_REQUEST_STATUSES),
  expiresAt: z.string().nullable(),
  network: z.enum(SOLANA_CLUSTERS),
  solanaPayUrl: z.string().nullable(),
});
