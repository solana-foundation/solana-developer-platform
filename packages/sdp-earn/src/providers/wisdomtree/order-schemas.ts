import { z } from "zod";

const decimal = z
  .string()
  .max(128)
  .regex(/^-?\d+(?:\.\d+)?$/);
const hash = z.string().max(255).nullish();

/** Load-bearing fields from Connect's WTCOrderDetailsResponse. */
export const wisdomTreeOrderDetailsSchema = z.object({
  blockchain: z.string().min(1),
  exchange_code: z.string().min(1),
  token_contract_address: z.string().min(1),
  settlement_wallet_address: z.string().min(1),
  trade_type: z.string().min(1),
  settlement_currency: z.string().min(1),
  settlement_currency_name: z.string().min(1),
  status: z.string().min(1),
  order_type: z.string().min(1).optional(),
  conversion_order_hash: hash,
  deposit_hash: hash,
  issuer_order_hash: hash,
  token_amount: decimal.nullish(),
  net_value: decimal.nullish(),
});

/** Parsed provider evidence; it is not proof of finalized on-chain delivery. */
export type WisdomTreeOrderDetails = z.infer<typeof wisdomTreeOrderDetailsSchema>;
