"use client";

/**
 * One party, rendered by how the API classifies it for the caller.
 *
 * A referenced counterparty is a link to its dashboard page — never plain
 * text, per the house rule for referenced entities — and so is a custodied
 * party's wallet, whose page is the label's destination. Anything else is an
 * external address, shortened to read and copyable in full.
 */

import { WalletAddressCopyButton } from "@/app/dashboard/custody/wallet-address-copy-button";
import { EntityLink } from "@/components/entity-link";
import { useTranslations } from "@/i18n/provider";
import { shortenAddress } from "../../payments/payments-overview.utils";
import type { DvpPartyRef } from "./dvp-trade";

/** A truncated address with the full value one copy-click away. */
export function AddressWithCopy({ address }: { address: string }) {
  return (
    <span className="inline-flex items-center gap-1">
      <span className="sr-only">{address}</span>
      <span aria-hidden>{shortenAddress(address)}</span>
      <WalletAddressCopyButton address={address} tooltip={address} />
    </span>
  );
}

/**
 * Two grid cells — who, then where — so a column of parties lines up: names
 * under names, addresses under addresses, whichever way each party is
 * classified. The parent supplies the grid; this renders as `contents`.
 */
export function DvpPartyCell({ party }: { party: DvpPartyRef }) {
  const t = useTranslations();
  const label = party.counterparty ? (
    <EntityLink
      href={`/dashboard/payments/counterparty/${encodeURIComponent(party.counterparty.id)}`}
    >
      {party.counterparty.label}
    </EntityLink>
  ) : party.wallet ? (
    <EntityLink href={`/dashboard/wallets/${encodeURIComponent(party.wallet.id)}`}>
      {party.wallet.name === null ? t("DashboardMarkets.dvp.partySdpWallet") : party.wallet.name}
    </EntityLink>
  ) : (
    <span className="text-tertiary">{t("DashboardMarkets.dvp.partyExternal")}</span>
  );
  return (
    <span className="contents">
      <span className="min-w-0 truncate">{label}</span>
      <AddressWithCopy address={party.address} />
    </span>
  );
}
