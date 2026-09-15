import type { UnifiedTransactionStatus } from "@sdp/types";

export interface UnifiedTransactionSourceHelpers {
  moduleStatusesOf(status: UnifiedTransactionStatus): readonly string[];
}

export interface UnifiedTransactionSource {
  sql(helpers: UnifiedTransactionSourceHelpers): string;
}
