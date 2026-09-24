export const PAYMENT_COMMAND_ACTION_DESTINATIONS = {
  pay: "/dashboard/payments/pay",
  deposit: "/dashboard/payments/deposit",
  request: "/dashboard/payments/requests",
  schedule: "/dashboard/payments/recurring/create",
} as const;

export const PAYMENT_COMMAND_ACTIVITY_DESTINATIONS = {
  transfers: "/dashboard/payments/transactions",
  batches: "/dashboard/payments/transactions?module=payments&kind=batch_pay",
} as const;

/** Where each count in the overview's summary line is managed. */
export const PAYMENT_COMMAND_SUMMARY_DESTINATIONS = {
  contacts: "/dashboard/payments/counterparty",
  openRequests: "/dashboard/payments/requests",
  schedules: "/dashboard/payments/recurring",
  providers: "/dashboard/integrations",
} as const;
