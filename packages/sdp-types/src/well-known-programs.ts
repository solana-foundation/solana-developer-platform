import { address } from "@solana/addresses";

/**
 * SPL Memo. Passed alongside token transfers so a destination with MemoTransfer
 * enabled can be paid; without it such a transfer reverts.
 */
// biome-ignore lint/security/noSecrets: public Solana Memo program address.
export const MEMO_PROGRAM_ADDRESS = address("MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr");
