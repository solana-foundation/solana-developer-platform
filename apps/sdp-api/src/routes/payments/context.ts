import { createD1Drizzle } from "@/db/drizzle";
import { createD1PaymentsRepository } from "@/db/repositories/payments.repository.d1";
import { createFeePaymentAdapter } from "@/services/adapters/fee-payment";
import type { Env } from "@/types/env";
import type { Address } from "@solana/kit";
import type { Context } from "hono";

export type AppContext = Context<{ Bindings: Env }>;

export function getPaymentsRepository(c: AppContext) {
  return createD1PaymentsRepository({ db: createD1Drizzle(c.env.DB) });
}

export function getFeePayment(c: AppContext) {
  return createFeePaymentAdapter(c.env);
}

export async function getSponsoredFeePayer(c: AppContext): Promise<Address> {
  return getFeePayment(c).getFeePayer();
}
