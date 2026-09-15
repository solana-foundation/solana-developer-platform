import { DVP_TRADE_STATUSES } from "./dvp";
import { EARN_MOVEMENT_STATUSES } from "./earn";
import { HELIUS_RINGS_OPERATION_STATUSES, HELIUS_RINGS_OPERATION_TYPES } from "./helius-rings";
import { PAYMENT_TRANSFER_STATUSES } from "./payments";
import { PRIVATE_CHANNEL_TRANSACTION_STATUSES } from "./private-channels";
import { TOKEN_TRANSACTION_STATUSES, TOKEN_TRANSACTION_TYPES } from "./tokens";

export const UNIFIED_TRANSACTION_MODULES = [
  "payments",
  "earn",
  "dvp",
  "private_channels",
  "issuance",
  "rings",
] as const;
export type UnifiedTransactionModule = (typeof UNIFIED_TRANSACTION_MODULES)[number];

export const UNIFIED_TRANSACTION_STATUSES = ["pending", "succeeded", "failed", "canceled"] as const;
export type UnifiedTransactionStatus = (typeof UNIFIED_TRANSACTION_STATUSES)[number];

export interface UnifiedTransactionModuleContract<Kind extends string, Status extends string> {
  kinds: readonly Kind[];
  moduleStatuses: readonly Status[];
  status: Record<Status, UnifiedTransactionStatus>;
}

export const EARN_TRANSACTION_MODULE_STATUSES = [
  ...new Set([...EARN_MOVEMENT_STATUSES.custodial, ...EARN_MOVEMENT_STATUSES.vault_direct]),
];

export const UNIFIED_TRANSACTION_MODULE_CONTRACTS = {
  payments: {
    kinds: [
      "pay",
      "confidential_pay",
      "batch_pay",
      "recurring_pay",
      "deposit",
      "request_deposit",
      "onramp",
      "offramp",
    ],
    moduleStatuses: PAYMENT_TRANSFER_STATUSES,
    status: {
      pending: "pending",
      processing: "pending",
      awaiting_payment: "pending",
      settling: "pending",
      confirmed: "succeeded",
      finalized: "succeeded",
      completed: "succeeded",
      failed: "failed",
      canceled: "canceled",
      expired: "canceled",
    } as const satisfies Record<
      (typeof PAYMENT_TRANSFER_STATUSES)[number],
      UnifiedTransactionStatus
    >,
  },
  earn: {
    kinds: ["deposit", "withdraw"],
    moduleStatuses: EARN_TRANSACTION_MODULE_STATUSES,
    status: {
      requested: "pending",
      processing: "pending",
      pending_approval: "pending",
      submitted: "pending",
      confirmed: "succeeded",
      finalized: "succeeded",
      completed: "succeeded",
      partially_completed: "succeeded",
      failed: "failed",
      cancelled: "canceled",
    } as const satisfies Record<
      (typeof EARN_TRANSACTION_MODULE_STATUSES)[number],
      UnifiedTransactionStatus
    >,
  },
  dvp: {
    kinds: ["fund", "close"],
    moduleStatuses: DVP_TRADE_STATUSES,
    status: {
      creating: "pending",
      created: "pending",
      partially_funded: "pending",
      funded: "pending",
      closed_unknown: "pending",
      settled: "succeeded",
      create_failed: "failed",
      cancelled: "canceled",
      rejected: "canceled",
      expired: "canceled",
    } as const satisfies Record<(typeof DVP_TRADE_STATUSES)[number], UnifiedTransactionStatus>,
  },
  private_channels: {
    kinds: ["transfer", "deposit", "withdraw"],
    moduleStatuses: PRIVATE_CHANNEL_TRANSACTION_STATUSES,
    status: {
      pending: "pending",
      submitted: "pending",
      confirmed: "succeeded",
      settled: "succeeded",
      failed: "failed",
    } as const satisfies Record<
      (typeof PRIVATE_CHANNEL_TRANSACTION_STATUSES)[number],
      UnifiedTransactionStatus
    >,
  },
  issuance: {
    kinds: TOKEN_TRANSACTION_TYPES,
    moduleStatuses: TOKEN_TRANSACTION_STATUSES,
    status: {
      pending: "pending",
      processing: "pending",
      confirmed: "succeeded",
      finalized: "succeeded",
      failed: "failed",
    } as const satisfies Record<
      (typeof TOKEN_TRANSACTION_STATUSES)[number],
      UnifiedTransactionStatus
    >,
  },
  rings: {
    kinds: HELIUS_RINGS_OPERATION_TYPES,
    moduleStatuses: HELIUS_RINGS_OPERATION_STATUSES,
    status: {
      draft: "pending",
      preparing: "pending",
      approval_required: "pending",
      proving: "pending",
      ready_to_sign: "pending",
      submitted: "pending",
      indexing: "pending",
      completed: "succeeded",
      failed: "failed",
      voided: "canceled",
    } as const satisfies Record<
      (typeof HELIUS_RINGS_OPERATION_STATUSES)[number],
      UnifiedTransactionStatus
    >,
  },
} as const satisfies {
  [M in UnifiedTransactionModule]: UnifiedTransactionModuleContract<string, string>;
};

type UnifiedTransactionContracts = typeof UNIFIED_TRANSACTION_MODULE_CONTRACTS;

export const PAYMENT_TRANSACTION_KINDS = UNIFIED_TRANSACTION_MODULE_CONTRACTS.payments.kinds;
export type PaymentTransactionKind = (typeof PAYMENT_TRANSACTION_KINDS)[number];

export type UnifiedTransactionKind<Module extends UnifiedTransactionModule> =
  UnifiedTransactionContracts[Module]["kinds"][number];

export type UnifiedTransactionModuleStatus<Module extends UnifiedTransactionModule> =
  UnifiedTransactionContracts[Module]["moduleStatuses"][number];

interface UnifiedTransactionCommon {
  id: string;
  moduleId: string;
  status: UnifiedTransactionStatus;
  organizationId: string;
  projectId: string | null;
  custodyWalletId: string | null;
  /** The custody wallet's user-set label; null when the wallet is unlabeled or the row has no wallet. */
  custodyWalletLabel: string | null;
  token: string | null;
  /** Exact decimal string in token units, or null when the source cannot resolve token decimals. */
  amount: string | null;
  counterpartyId: string | null;
  signature: string | null;
  createdAt: string;
}

export type UnifiedTransaction = {
  [Module in UnifiedTransactionModule]: UnifiedTransactionCommon & {
    module: Module;
    kind: UnifiedTransactionKind<Module>;
    moduleStatus: UnifiedTransactionModuleStatus<Module>;
  };
}[UnifiedTransactionModule];

export interface UnifiedTransactionsListResponse {
  transactions: UnifiedTransaction[];
  nextCursor: string | null;
}
