import { CUSTODY_PROVIDERS, type CustodyProvider } from "@sdp/types/custody";
import { custodyProviderStartsMovement, type MovementId } from "@sdp/types/movements";
import type { MessageKey } from "@/i18n/messages";
import type { TranslationValues } from "@/i18n/translate";

/**
 * Which wallets a source picker may offer (PRO-2435 D1): a custody provider
 * whose signing can wait for a human approval starts only the movements
 * `CUSTODY_PROVIDER_START_MOVEMENTS` lists for it, and the API refuses it as
 * the source of every other start. The pickers that start one of those
 * movements leave such a wallet out, so the refusal is never reached from the
 * dashboard; direct Pay and every destination picker keep it.
 *
 * Every wallet row the dashboard reads carries the three fields the rule
 * needs, whatever its module names the row type.
 */
export interface MovementWallet {
  /** Display-only on some rows, so any string: an unknown provider starts everything. */
  provider?: string | null;
  /** Set when the wallet lives on a connection the customer brought (BYOK). */
  custodyConnectionId?: string | null;
  /** Set when the wallet lives on the deployment's own provider account (managed). */
  custodyConfigId?: string | null;
}

/** The one line every picker shows when the rule alone emptied it. */
export const HELD_BACK_WALLETS_KEY =
  "Shared.custodyWallets.fireblocksDirectPaymentsOnly" satisfies MessageKey;

type Translate = (key: MessageKey, values?: TranslationValues) => string;

function isCustodyProvider(value: string): value is CustodyProvider {
  return (CUSTODY_PROVIDERS as readonly string[]).includes(value);
}

/**
 * Whether a wallet may be the source of `movement`. A wallet with no provider,
 * or one this build does not know, passes: the rule names providers, and only
 * the ones it names are held back.
 */
export function walletStartsMovement(wallet: MovementWallet, movement: MovementId): boolean {
  const provider = wallet.provider;
  if (!provider || !isCustodyProvider(provider)) return true;
  return custodyProviderStartsMovement(
    provider,
    wallet.custodyConnectionId ? "byok" : "managed",
    movement
  );
}

/** The wallets a source picker for `movement` offers, in their original order. */
export function walletsStartingMovement<Wallet extends MovementWallet>(
  wallets: readonly Wallet[],
  movement: MovementId
): Wallet[] {
  return wallets.filter((wallet) => walletStartsMovement(wallet, movement));
}

/**
 * Whether the rule alone emptied a picker: wallets exist, and none may start
 * `movement`. False for a project with no wallets at all, which keeps its own
 * empty state.
 */
export function allWalletsHeldBack(
  wallets: readonly MovementWallet[],
  movement: MovementId
): boolean {
  return wallets.length > 0 && !wallets.some((wallet) => walletStartsMovement(wallet, movement));
}

/** The explanation a picker shows when the rule alone emptied it, else null. */
export function heldBackWalletsHint(
  wallets: readonly MovementWallet[],
  movement: MovementId,
  t: Translate
): string | null {
  return allWalletsHeldBack(wallets, movement) ? t(HELD_BACK_WALLETS_KEY) : null;
}
