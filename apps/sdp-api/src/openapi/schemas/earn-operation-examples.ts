import { type Operation, operationResponseSchema } from "@sdp/types/operations";
import { successResponseSchema, withOpenApi } from "./base";
import { EARN_EXAMPLE_IDS, EARN_OWNER_ADDRESS_EXAMPLE } from "./earn-examples";

/** Devnet USDC and the example position's share mint, as in the positions examples. */
const USDC = "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU";
const SHARES = "hXm2xSRF5PLKGMrTvAWqKhR76MuJX5dAabeSChkjqu2";
const OWNER = { ownerAddress: EARN_OWNER_ADDRESS_EXAMPLE };

/** An unsigned v0 transaction whose fee payer and signer is the example owner. */
const UNSIGNED_TRANSACTION =
  "AQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAACAAQACBX6MCIdgv94d3c8ywX8gm4JC7lKq8TH6zYjQ6ixtCwbyAcUXmthoicMvwQoemkkh8VYuH2cWunAQDIuT/GkDUJ0KYgMMHq4BIvb2PBZ0fI2yv1bG0iLGqFi+JMFe0tIQCTtELLORIVfxOpM9ATQoLQMrX/7NAaLb8bd5BgjfAC6nCWPLASE2WfQBsHH1iKEwbap6S3HQJ5LgWwCcHCsv79/MSQ6SjNLjhzuzQ/yV2jMXnKYPTb9GwsNukSmdVdTmuQEEBAABAgMQ8iPGiVLh8rYA4fUFAAAAAAA=";

const DEPOSIT_PREPARED: Operation = {
  id: "op_5f2a9c1e-8d4b-4f6a-9b3e-2c7d1a0e6f84",
  kind: "earn.deposit",
  status: "prepared",
  environment: "sandbox",
  intent: {
    kind: "earn.deposit",
    strategyId: EARN_EXAMPLE_IDS.strategy,
    source: OWNER,
    amount: { mint: USDC, value: "100" },
    slippageBps: 50,
  },
  actionId: "opa_0c8e1f4a-6b2d-4e9a-8f3c-5d7b9a1e2c40",
  version: 1,
  nextAction: {
    type: "sign_transaction",
    transaction: UNSIGNED_TRANSACTION,
    lastValidBlockHeight: "312345678",
    expiresAt: null,
  },
  terms: {
    inputAmount: { mint: USDC, value: "100" },
    description: "Deposit into the strategy",
    expiresAt: null,
    estimate: { mint: SHARES, value: "98.41" },
    minimum: { mint: SHARES, value: "97.92" },
    fees: null,
    options: [],
  },
  buildRef: {
    kind: "earn.strategy_transaction",
    id: "earn_wallet_transaction_7d3e9b2a-1c5f-4a8e-b6d0-3f9a2e7c1b58",
  },
  resourceRef: null,
  canCancel: false,
  cancelRequestedAt: null,
  error: null,
  result: null,
  createdAt: "2026-11-20T15:00:00.000Z",
  updatedAt: "2026-11-20T15:00:00.000Z",
};

const DEPOSIT_QUEUED: Operation = {
  ...DEPOSIT_PREPARED,
  status: "queued",
  nextAction: { type: "wait", reason: "Execution queued" },
  updatedAt: "2026-11-20T15:00:20.000Z",
};

const DEPOSIT_COMPLETED: Operation = {
  ...DEPOSIT_PREPARED,
  status: "completed",
  nextAction: null,
  resourceRef: {
    kind: "earn.movement",
    id: "earn_movement_9a1c3e5b-7d2f-4b8a-a6e0-1c3d5f7b9e21",
  },
  result: {
    positionId: EARN_EXAMPLE_IDS.position,
    strategyId: EARN_EXAMPLE_IDS.strategy,
    signature:
      "5VERv8NMvzbJMEkV8xnrLkEaWRtSz9CosKDYjCJjBRnbJLgp8uirBgmQpjKhoR4tjF3ZpRzrFmBV6UjKdiSZkQUW",
    source: OWNER,
    settledAmount: { mint: USDC, value: "100" },
    settlementOutcome: "delivered",
  },
  updatedAt: "2026-11-20T15:00:41.000Z",
};

const DIRECT_EXIT = {
  id: "direct",
  label: "Direct withdrawal",
  settlement: "instant",
  estimatedSeconds: null,
  mechanism: "direct",
  amount: { mint: USDC, value: "25.81" },
  minimum: { mint: USDC, value: "25.68" },
} as const;

const QUEUED_EXIT = {
  id: "solver_queue:5:259200",
  label: "Solver queue (5 bps discount, 259200s window)",
  settlement: "delayed",
  estimatedSeconds: null,
  mechanism: "solver_queue",
  amount: { mint: USDC, value: "25.80" },
  minimum: null,
} as const;

const WITHDRAWAL_CHOICE: Operation = {
  id: "op_b7e2d4a1-3c9f-4e6b-8a2d-6f1e3c5a7b90",
  kind: "earn.withdraw",
  status: "prepared",
  environment: "sandbox",
  intent: { kind: "earn.withdraw", positionId: EARN_EXAMPLE_IDS.position, amount: { kind: "all" } },
  actionId: "opa_4e6a8c2b-9d1f-4a3e-b5c7-0e2a4c6e8a13",
  version: 1,
  nextAction: { type: "select_option" },
  terms: {
    inputAmount: { mint: SHARES, value: "25.42" },
    description: "Choose a withdrawal route before reviewing its transaction",
    expiresAt: null,
    estimate: null,
    minimum: null,
    fees: null,
    options: [DIRECT_EXIT, QUEUED_EXIT],
  },
  buildRef: { kind: "earn.withdrawal_options", id: "choices_2b4d6f8a-1c3e-4a5b-9d7f-8e0a2c4e6a35" },
  resourceRef: null,
  canCancel: true,
  cancelRequestedAt: null,
  error: null,
  result: null,
  createdAt: "2026-11-21T09:30:00.000Z",
  updatedAt: "2026-11-21T09:30:00.000Z",
};

const WITHDRAWAL_ROUTE_CHOSEN: Operation = {
  ...WITHDRAWAL_CHOICE,
  actionId: "opa_8a0c2e4b-6d8f-4b1a-a3c5-7e9b1d3f5a77",
  version: 2,
  nextAction: {
    type: "sign_transaction",
    transaction: UNSIGNED_TRANSACTION,
    lastValidBlockHeight: "312401250",
    expiresAt: null,
  },
  terms: {
    ...WITHDRAWAL_CHOICE.terms,
    description: DIRECT_EXIT.label,
    estimate: DIRECT_EXIT.amount,
    minimum: DIRECT_EXIT.minimum,
    options: [DIRECT_EXIT],
  },
  buildRef: {
    kind: "earn.strategy_transaction",
    id: "earn_wallet_transaction_3c5e7a9b-2d4f-4c6a-8e0b-5a7c9e1b3d62",
  },
  canCancel: false,
  updatedAt: "2026-11-21T09:30:12.000Z",
};

const WITHDRAWAL_CANCELLED: Operation = {
  ...WITHDRAWAL_CHOICE,
  status: "cancelled",
  nextAction: null,
  canCancel: false,
  cancelRequestedAt: "2026-11-21T09:31:05.000Z",
  updatedAt: "2026-11-21T09:31:05.000Z",
};

/** One realistic response per operation route, each checked against the public schema. */
export const EARN_OPERATION_EXAMPLES = {
  deposit: DEPOSIT_PREPARED,
  withdraw: WITHDRAWAL_CHOICE,
  submit: DEPOSIT_QUEUED,
  refresh: WITHDRAWAL_ROUTE_CHOSEN,
  cancel: WITHDRAWAL_CANCELLED,
  get: DEPOSIT_COMPLETED,
  list: { operations: [WITHDRAWAL_CHOICE, DEPOSIT_COMPLETED], nextCursor: null },
} as const;

/** The shared operation envelope, carrying one route's example. */
export function operationResponseExample(operation: Operation) {
  return successResponseSchema(withOpenApi(operationResponseSchema, { example: { operation } }));
}
