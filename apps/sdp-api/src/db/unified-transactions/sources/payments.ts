import type { PaymentTransferBatchRecipientStatus, PaymentTransferType } from "@sdp/types/payments";
import type { TokenMovementLegStatus } from "@sdp/types/token-movements";
import { PAYMENT_TRANSACTION_KIND_SQL } from "@/db/repositories/payments.kind";
import type { PaymentTransferDirection } from "@/db/repositories/payments.repository";
import type { UnifiedTransactionSource } from "./types";

const BATCH_CHUNK = "transfer_batch" satisfies PaymentTransferType;
const OFFRAMP = "offramp" satisfies PaymentTransferType;
const INBOUND = "inbound" satisfies PaymentTransferDirection;
const ARCHIVED_RECIPIENT = "archived" satisfies PaymentTransferBatchRecipientStatus;
const ARCHIVED_LEG = "archived" satisfies TokenMovementLegStatus;

/**
 * Exact token units of a base-unit column: base units ÷ 10^decimals. The
 * dividend's scale is set to `decimals` first, so the quotient keeps every
 * digit (the scale PostgreSQL picks by itself can round at 17+ decimals).
 */
function tokenUnits(baseUnits: string, decimals: string): string {
  return `round((${baseUnits})::numeric, ${decimals}) / (10::numeric ^ ${decimals})`;
}

/**
 * A row's amount, in token units (ADR 0012): what it moved from or to its own
 * wallet, as the transfer API's `amount` reports it. A row with legs reads
 * them; a row with none (legacy) keeps its stored text. Outbound rows show
 * the quoted debit. An off-ramp shows its credit, the provider's deposit
 * amount; an inbound row shows its credit. A batch chunk sums the debits of
 * the recipients it pays, as its stored amount does (an archived recipient is
 * deleted).
 */
const AMOUNT_SQL = `CASE
    WHEN pt.type = '${BATCH_CHUNK}' THEN COALESCE((
      SELECT trim_scale(sum(${tokenUnits("leg.quoted_debit", "leg.decimals")}))::text
        FROM payment_transfer_recipients recipient
        JOIN token_movement_legs leg ON leg.payment_transfer_recipient_id = recipient.id
       WHERE recipient.transfer_id = pt.id
         AND recipient.status <> '${ARCHIVED_RECIPIENT}'
         AND leg.status <> '${ARCHIVED_LEG}'
    ), pt.amount)
    ELSE COALESCE((
      SELECT trim_scale(${tokenUnits(
        `CASE WHEN pt.direction = '${INBOUND}' OR pt.type = '${OFFRAMP}' THEN leg.quoted_credit ELSE leg.quoted_debit END`,
        "leg.decimals"
      )})::text
        FROM token_movement_legs leg
       WHERE leg.payment_transfer_id = pt.id
         AND leg.status <> '${ARCHIVED_LEG}'
    ), pt.amount)
  END`;

export const paymentsUnifiedTransactionSource = {
  sql: () => `SELECT
  pt.id,
  pt.id AS module_id,
  ${PAYMENT_TRANSACTION_KIND_SQL} AS kind,
  pt.status AS module_status,
  pt.organization_id,
  pt.project_id,
  pt.custody_wallet_id,
  pt.token,
  ${AMOUNT_SQL} AS amount,
  pt.counterparty_id,
  pt.signature,
  pt.created_at
FROM payment_transfers pt`,
} as const satisfies UnifiedTransactionSource;
