import type { CustodyWalletPurpose } from "@sdp/types/custody";
import { WALLET_PURPOSE_OWNERS } from "@sdp/types/release-channels";
import type { DashboardFlags } from "@/flags/dashboard";

/** The flags a wallet purpose's owner reads, each already capped at the release channel. */
export type WalletPurposeFlags = Pick<DashboardFlags, "dvp" | "issuance" | "markets">;

type WalletPurposeOwner = (typeof WALLET_PURPOSE_OWNERS)[CustodyWalletPurpose];

/** Whether each owner's dashboard area is on, mirroring the sidebar. */
const WALLET_PURPOSE_OWNER_ENABLED = {
  core: () => true,
  issuance: (flags) => flags.issuance,
  dvp: (flags) => flags.markets && flags.dvp,
} as const satisfies Record<WalletPurposeOwner, (flags: WalletPurposeFlags) => boolean>;

/**
 * Whether the dashboard offers a wallet purpose: a core purpose always, a module's purpose only
 * where that module's area is on. Stable runs no Issuance, so it offers no mint or freeze
 * authority.
 *
 * @param purpose - The wallet purpose.
 * @param flags - The dashboard's flag snapshot.
 * @returns True when a picker may list the purpose.
 */
export function isWalletPurposeOffered(
  purpose: CustodyWalletPurpose,
  flags: WalletPurposeFlags
): boolean {
  return WALLET_PURPOSE_OWNER_ENABLED[WALLET_PURPOSE_OWNERS[purpose]](flags);
}
