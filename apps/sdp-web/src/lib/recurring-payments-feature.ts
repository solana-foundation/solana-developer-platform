export function isRecurringPaymentsDashboardEnabled(): boolean {
  return process.env.NEXT_PUBLIC_PAYMENTS_RECURRING_ENABLED === "true";
}
