export const PAYMENT_COMMAND_ACTION_DESTINATIONS = {
  pay: "/dashboard/payments/pay",
  deposit: "/dashboard/payments/deposit",
  request: "/dashboard/payments/requests",
  schedule: "/dashboard/payments/recurring/create",
} as const;

export const PAYMENT_COMMAND_ACTIVITY_DESTINATIONS = {
  transfers: "/dashboard/payments/transactions?tab=payments&kind=pay",
  batches: "/dashboard/payments/transactions?tab=payments&kind=batch_pay",
} as const;
