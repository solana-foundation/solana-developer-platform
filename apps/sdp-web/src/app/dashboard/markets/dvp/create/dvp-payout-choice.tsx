"use client";

/**
 * Where one side's proceeds are paid.
 *
 * Two options rather than an optional box, for two reasons. The default is
 * worth stating: a side is paid back at the address it funded from, and a blank
 * input never said that. And redirecting a payout is the shape a forged trade
 * takes, so it should read as a deliberate choice rather than something you
 * discover by opening a disclosure.
 *
 * Named by PARTY, not by leg. "Asset side is paid to" told you which token
 * moved and never whose money it was, and on a trade between two other parties
 * it did not describe anything at all.
 */

import { Input } from "@/components/ui/input";
import { useTranslations } from "@/i18n/provider";
import { cn } from "@/lib/utils";
import { shortenAddress } from "../../../payments/payments-overview.utils";
import type { DvpPayout } from "./use-dvp-destinations";

export function PayoutChoice({
  id,
  party,
  partyLabel,
  payout,
}: {
  id: string;
  /** The address that funds this side, when it is known yet. */
  party: string;
  /** Whose side this is, in the words the current trade kind uses. */
  partyLabel: string;
  payout: DvpPayout;
}) {
  const t = useTranslations();
  const redirected = payout.mode === "elsewhere";

  const options = [
    {
      mode: "party" as const,
      title: party
        ? t("DashboardMarkets.dvp.payoutToPartyWithAddress", { address: shortenAddress(party) })
        : t("DashboardMarkets.dvp.payoutToParty"),
    },
    { mode: "elsewhere" as const, title: t("DashboardMarkets.dvp.payoutElsewhere") },
  ];

  return (
    <fieldset className="grid gap-2 rounded-xl border border-border-subtle p-4">
      <legend className="px-1 font-medium text-primary text-sm">{partyLabel}</legend>

      <div className="grid gap-2">
        {options.map((option) => {
          const selected = payout.mode === option.mode;
          return (
            <label
              className={cn(
                "flex cursor-pointer items-center gap-2.5 rounded-lg px-2 py-1.5 transition-colors",
                "focus-within:ring-2 focus-within:ring-border-strong",
                selected ? "bg-fill-subtle" : "hover:bg-fill-subtle"
              )}
              key={option.mode}
            >
              <input
                checked={selected}
                className="sr-only"
                name={`${id}-mode`}
                onChange={() => payout.setMode(option.mode)}
                type="radio"
                value={option.mode}
              />
              <span
                aria-hidden
                className={cn(
                  "flex h-4 w-4 shrink-0 items-center justify-center rounded-full border transition-colors",
                  selected ? "border-primary" : "border-border-strong"
                )}
              >
                {selected ? <span className="h-2 w-2 rounded-full bg-primary" /> : null}
              </span>
              <span className="min-w-0 text-primary text-sm">{option.title}</span>
            </label>
          );
        })}
      </div>

      {redirected ? (
        <div className="mt-1 grid gap-1.5">
          <Input
            aria-invalid={payout.looksWrong}
            aria-label={t("DashboardMarkets.dvp.payoutAddressLabel", { party: partyLabel })}
            className="text-xs"
            id={id}
            onChange={(event) => payout.setAddress(event.target.value)}
            placeholder={t("DashboardMarkets.dvp.payoutAddressPlaceholder")}
            spellCheck={false}
            value={payout.address}
          />
          <p className={cn("text-xs", payout.looksWrong ? "text-error" : "text-tertiary")}>
            {payout.looksWrong
              ? t("DashboardMarkets.dvp.fieldCounterpartyInvalid")
              : t("DashboardMarkets.dvp.payoutElsewhereHint")}
          </p>
        </div>
      ) : null}
    </fieldset>
  );
}
