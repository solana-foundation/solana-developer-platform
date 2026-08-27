import {
  type RampProviderId,
  type RampSettlementVerification,
  type RampTransferSettlement,
  rampSettlementAssurance,
} from "@sdp/types";
import {
  isRampTransferType,
  type PaymentTransferRow as TransferRow,
} from "@/db/repositories/payments.repository";
import { AppError } from "@/lib/errors";
import { mapMoneygramTransferDetails } from "./mappers/moneygram";

export function mapTransferRow(row: TransferRow) {
  const base = {
    id: row.id,
    organizationId: row.organization_id,
    walletId: row.wallet_id,
    ...(row.project_id ? { projectId: row.project_id } : {}),
    type: row.type,
    direction: row.direction,
    status: row.status,
    signature: row.signature,
    serializedTx: row.serialized_tx,
    slot: row.slot,
    blockTime: row.block_time,
    fee: row.fee,
    error: row.error,
    ...(row.initiated_by_key_id
      ? {
          initiatedBy: {
            type: "api_key",
            id: row.initiated_by_key_id,
          },
        }
      : {}),
    ...(row.source_address ? { source: row.source_address } : {}),
    ...(row.destination_address ? { destination: row.destination_address } : {}),
    ...(row.counterparty_id ? { counterpartyId: row.counterparty_id } : {}),
    ...(row.counterparty_display_name
      ? { counterpartyDisplayName: row.counterparty_display_name }
      : {}),
    ...(row.memo ? { memo: row.memo } : {}),
    rampsMemo: row.ramps_memo,
    token: row.token,
    ...(row.amount ? { amount: row.amount } : {}),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };

  if (!isRampTransferType(row.type)) {
    return base;
  }

  if (!row.provider) {
    throw new AppError("INTERNAL_ERROR", "Ramp transfer is missing provider.");
  }

  const settlement = row.provider_data.settlement as RampTransferSettlement | undefined;
  const direction = row.type === "offramp" ? "offramp" : "onramp";
  // Always present on ramp transfers so callers branch on a value, never on absence (#559).
  // `verified` is only ever reported from a recorded on-chain signature; a provider simply
  // saying it settled leaves this `unsupported`, which is the honest report of what we know.
  // Keyed off settlement_verified_at, NOT settlement_signature. The signature is a provider's
  // CLAIM, recorded the moment a webhook arrives; settlement_verified_at is only written after
  // the transaction has been checked on chain. Reading the claim as proof would report
  // "verified on-chain" for something nothing has verified, which is the exact failure this
  // field exists to prevent (#559).
  const settlementVerification: RampSettlementVerification = row.settlement_verified_at
    ? {
        status: "verified",
        method: row.settlement_verification_method as RampSettlementVerification["method"],
        signature: row.settlement_signature,
        slot: row.settlement_verified_slot,
        verifiedAt: row.settlement_verified_at,
      }
    : {
        status:
          rampSettlementAssurance(row.provider as RampProviderId, direction) === "onchain"
            ? "pending"
            : "unsupported",
        method: null,
        signature: null,
        slot: null,
        verifiedAt: null,
      };
  const moneygram = mapMoneygramTransferDetails(row);
  return {
    ...base,
    provider: row.provider,
    ...(row.provider_reference ? { providerReference: row.provider_reference } : {}),
    ...(row.delivery_mode ? { deliveryMode: row.delivery_mode } : {}),
    ...(row.fiat_currency ? { fiatCurrency: row.fiat_currency } : {}),
    ...(row.fiat_amount ? { fiatAmount: row.fiat_amount } : {}),
    ...(settlement ? { settlement } : {}),
    settlementVerification,
    ...(moneygram ? { moneygram } : {}),
  };
}
