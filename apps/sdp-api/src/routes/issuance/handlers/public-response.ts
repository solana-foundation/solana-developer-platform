import type {
  PublicTokenTransaction,
  Token,
  TokenTransaction,
  TokenTransactionListItem,
} from "@sdp/types";

/** Keep rollback and operation identity fields internal to Issuance persistence. */
export function toPublicToken<T extends Token>(token: T): Omit<T, "signingWalletId"> {
  const { signingWalletId: _signingWalletId, ...publicToken } = token;
  return publicToken;
}

export function toPublicTokenTransaction<
  T extends PublicTokenTransaction & { custodyWalletId?: string | null },
>(transaction: T): Omit<T, "custodyWalletId"> {
  const { custodyWalletId: _custodyWalletId, ...publicTransaction } = transaction;
  return publicTransaction;
}

export function toPublicTokenTransactionListItem(
  item: Omit<TokenTransactionListItem, "transaction"> & { transaction: TokenTransaction }
) {
  return {
    ...item,
    transaction: toPublicTokenTransaction(item.transaction),
  };
}
