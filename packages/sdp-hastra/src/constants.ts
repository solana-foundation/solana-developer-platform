// Public Solana program addresses, never credentials.
export const SYSTEM_PROGRAM_ID = "11111111111111111111111111111111";
// biome-ignore lint/security/noSecrets: public SPL Token program id, not a credential.
export const TOKEN_PROGRAM_ID = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
// biome-ignore lint/security/noSecrets: public Associated Token program id, not a credential.
export const ASSOCIATED_TOKEN_PROGRAM_ID = "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL";
export const COMPUTE_BUDGET_PROGRAM_ID = "ComputeBudget111111111111111111111111111111";
// biome-ignore lint/security/noSecrets: public Jupiter aggregator program id, not a credential.
export const JUPITER_AGGREGATOR_PROGRAM_ID = "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4";
export const UPGRADEABLE_LOADER_ID = "BPFLoaderUpgradeab1e11111111111111111111111";

export const TOKEN_DECIMALS = 6;
export const U64_MAX = (1n << 64n) - 1n;
export const I128_SIGN = 1n << 127n;
export const I128_MODULUS = 1n << 128n;
export const MAX_ADMINISTRATORS = 5;
export const RPC_READ_TIMEOUT_MS = 30_000;
export const CLASSIC_TOKEN_ACCOUNT_BYTES = 165;
/** Anchor `RedemptionRequest`: discriminator + owner + amount + mint + bump. */
export const REDEMPTION_REQUEST_ACCOUNT_BYTES = 81;
export const SIGNATURE_HISTORY_PAGE_SIZE = 1_000;
export const MAX_SIGNATURE_HISTORY_PAGES = 10;

/** Native-only deposit and par-request ceiling. */
export const HASTRA_NATIVE_COMPUTE_UNIT_LIMIT = 600_000;
/** Native PRIME redemption plus an admitted Jupiter route. */
export const HASTRA_SWAP_COMPUTE_UNIT_LIMIT = 1_200_000;
/** Keep enough Jupiter accounts free for Hastra's own accounts and ATA setup. */
export const HASTRA_JUPITER_MAX_ACCOUNTS = 20;
/** Smallest non-zero wYLDS request the v0.0.6 program itself accepts. */
export const HASTRA_PAR_MINIMUM_ASSETS = "0.000001";
export const HASTRA_PAR_MINIMUM_ASSET_ATOMS = 1n;
/**
 * A closed owner PDA has no cycle nonce. Wait beyond Solana's recent-blockhash
 * processing window before allowing the same address to represent a new debt.
 */
export const HASTRA_REQUEST_REUSE_COOLDOWN_BLOCKS = 200;
