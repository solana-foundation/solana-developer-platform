import type { AppDb } from "@/db";
import type {
  ClaimSettlementInput,
  PrivateChannelSettlementIntentKind,
  PrivateChannelSettlementObservationRepository,
  PrivateChannelSettlementObservationRow,
} from "./private-channel-settlement-observation.repository";

function mapRow(row: Record<string, unknown>): PrivateChannelSettlementObservationRow {
  return {
    signature: row.signature as string,
    instruction_index: Number(row.instruction_index),
    intent_kind: row.intent_kind as PrivateChannelSettlementIntentKind,
    intent_id: row.intent_id as string,
    destination: row.destination as string,
    mint: row.mint as string,
    amount: row.amount as string,
    block_time:
      row.block_time === null || row.block_time === undefined ? null : Number(row.block_time),
    observed_at: row.observed_at as string,
  };
}

export function createPostgresPrivateChannelSettlementObservationRepository(
  db: AppDb
): PrivateChannelSettlementObservationRepository {
  return {
    async claimSettlement(input: ClaimSettlementInput) {
      // ON CONFLICT DO NOTHING covers both unique keys — the PK
      // (signature, instruction_index) and UNIQUE (intent_kind, intent_id).
      // Racing pollers land here first; the loser sees zero rows returned,
      // then reads the winner via findByIntent to get the settlement_ref.
      const row = await db
        .prepare(
          `INSERT INTO private_channel_settlement_observations (
               signature, instruction_index, intent_kind, intent_id,
               destination, mint, amount, block_time
             ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT DO NOTHING
             RETURNING *`
        )
        .bind(
          input.signature,
          input.instructionIndex,
          input.intentKind,
          input.intentId,
          input.destination,
          input.mint,
          input.amount,
          input.blockTime
        )
        .first<Record<string, unknown>>();
      return row ? mapRow(row) : null;
    },

    async findByIntent(intentKind, intentId) {
      const row = await db
        .prepare(
          `SELECT * FROM private_channel_settlement_observations
             WHERE intent_kind = ? AND intent_id = ?`
        )
        .bind(intentKind, intentId)
        .first<Record<string, unknown>>();
      return row ? mapRow(row) : null;
    },
  };
}
