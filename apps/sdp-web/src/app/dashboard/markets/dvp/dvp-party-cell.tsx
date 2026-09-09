"use client";

/**
 * One party, rendered by how the API classifies it for the caller.
 *
 * A referenced counterparty is a link to its dashboard page — never plain
 * text, per the house rule for referenced entities. A custodied party is the
 * caller's own wallet, marked "yours". Anything else is an external address,
 * shortened to read and copyable in full.
 */

import { WalletAddressCopyButton } from "@/app/dashboard/custody/wallet-address-copy-button";
import { EntityLink } from "@/components/entity-link";
import { Badge } from "@/components/ui/badge";
import { useTranslations } from "@/i18n/provider";
import { shortenAddress } from "../../payments/payments-overview.utils";
import type { DvpPartyRef } from "./dvp-trade";

/** A truncated address with the full value one copy-click away. */
function AddressWithCopy({ address }: { address: string }) {
  return (
    <span className="inline-flex items-center gap-1">
      <span className="sr-only">{address}</span>
      <span aria-hidden>{shortenAddress(address)}</span>
      <WalletAddressCopyButton address={address} tooltip={address} />
    </span>
  );
}

export function DvpPartyCell({ party }: { party: DvpPartyRef }) {
  const t = useTranslations();
  if (party.counterparty) {
    return (
      <span className="inline-flex min-w-0 items-center gap-1.5">
        <EntityLink
          href={`/dashboard/payments/counterparty/${encodeURIComponent(party.counterparty.id)}`}
        >
          {party.counterparty.label}
        </EntityLink>
        <AddressWithCopy address={party.address} />
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1.5">
      <AddressWithCopy address={party.address} />
      {party.custodied ? (
        <Badge variant="outline">{t("DashboardMarkets.dvp.partyYours")}</Badge>
      ) : null}
    </span>
  );
}
