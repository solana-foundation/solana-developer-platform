import type { UnifiedTransactionModule } from "@sdp/types";
import { dvpUnifiedTransactionSource } from "./dvp";
import { earnUnifiedTransactionSource } from "./earn";
import { issuanceUnifiedTransactionSource } from "./issuance";
import { paymentsUnifiedTransactionSource } from "./payments";
import { privateChannelsUnifiedTransactionSource } from "./private-channels";
import { ringsUnifiedTransactionSource } from "./rings";
import type { UnifiedTransactionSource } from "./types";

export type { UnifiedTransactionSource } from "./types";

export const UNIFIED_TRANSACTION_SOURCES = {
  payments: paymentsUnifiedTransactionSource,
  earn: earnUnifiedTransactionSource,
  dvp: dvpUnifiedTransactionSource,
  private_channels: privateChannelsUnifiedTransactionSource,
  issuance: issuanceUnifiedTransactionSource,
  rings: ringsUnifiedTransactionSource,
} as const satisfies Record<UnifiedTransactionModule, UnifiedTransactionSource>;
