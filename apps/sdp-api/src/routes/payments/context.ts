import type { Address } from "@solana/kit";
import type { Context } from "hono";
import { createPaymentSubscriptionsRepository, createPaymentsRepository } from "@/db/repositories";
import * as feePaymentAdapters from "@/services/adapters/fee-payment";
import type { Env } from "@/types/env";

export type AppContext = Context<{ Bindings: Env }>;

export function getPaymentsRepository(c: AppContext) {
  return createPaymentsRepository(c.env);
}

export function getPaymentSubscriptionsRepository(c: AppContext) {
  return createPaymentSubscriptionsRepository(c.env);
}

export function getFeePayment(c: AppContext) {
  return feePaymentAdapters.createFeePaymentAdapter(c.env);
}

export async function getSponsoredFeePayer(c: AppContext): Promise<Address> {
  return getFeePayment(c).getFeePayer();
}
