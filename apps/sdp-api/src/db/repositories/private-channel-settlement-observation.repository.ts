import type { RepositoryDbClient } from "./base";

/** Kind of intent an observation attributes a settlement to. */
export type PrivateChannelSettlementIntentKind = "deposit" | "withdrawal";

export interface PrivateChannelSettlementObservationRow {
  signature: string;
  instruction_index: number;
  intent_kind: PrivateChannelSettlementIntentKind;
  intent_id: string;
  destination: string;
  mint: string;
  amount: string;
  block_time: number | null;
  observed_at: string;
}

export interface ClaimSettlementInput {
  signature: string;
  instructionIndex: number;
  intentKind: PrivateChannelSettlementIntentKind;
  intentId: string;
  destination: string;
  mint: string;
  amount: string;
  blockTime: number | null;
}

export interface PrivateChannelSettlementObservationRepository {
  /**
   * Insert an observation claiming an intent's settlement. Racing pollers collide
   * on `UNIQUE (intent_kind, intent_id)`; the loser returns `null` and reads the
   * winner via {@link findByIntent}.
   */
  claimSettlement(
    input: ClaimSettlementInput
  ): Promise<PrivateChannelSettlementObservationRow | null>;

  /** Look up the observation that already settled this intent, if any. */
  findByIntent(
    intentKind: PrivateChannelSettlementIntentKind,
    intentId: string
  ): Promise<PrivateChannelSettlementObservationRow | null>;
}

export interface PrivateChannelSettlementObservationRepositoryContext {
  db: RepositoryDbClient;
}
