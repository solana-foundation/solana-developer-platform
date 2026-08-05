"use client";

import { InfoIcon } from "lucide-react";
import type { MessageKey } from "@/i18n/messages";
import { useTranslations } from "@/i18n/provider";
import { formatApy } from "../earn-format";
import {
  SelectableCard,
  SelectionAnnouncement,
  SelectionMark,
  StepListSkeleton,
  StepNote,
  StepNotice,
} from "./earn-deposit-chrome";
import type { EarnDepositProfile, ProfileSummary } from "./earn-deposit-model";

/**
 * Profile copy keys. Flat keys rather than a nested map because the set is
 * closed and typed — a new profile is a compile error until its copy exists.
 *
 * Each card carries exactly ONE sentence (the tagline) plus a stat block; the
 * access constraint lives in the stat's meta line. An earlier draft had a
 * second explanatory sentence per card and it read as clutter — the tagline
 * and the constraint said the same thing twice in different words.
 */
const PROFILE_COPY: Record<
  EarnDepositProfile,
  { name: MessageKey; tagline: MessageKey; access: MessageKey }
> = {
  liquidity: {
    name: "DashboardEarn.deposit.profileLiquidityName",
    tagline: "DashboardEarn.deposit.profileLiquidityTagline",
    access: "DashboardEarn.deposit.profileLiquidityAccess",
  },
  balanced: {
    name: "DashboardEarn.deposit.profileBalancedName",
    tagline: "DashboardEarn.deposit.profileBalancedTagline",
    access: "DashboardEarn.deposit.profileBalancedAccess",
  },
  yield: {
    name: "DashboardEarn.deposit.profileYieldName",
    tagline: "DashboardEarn.deposit.profileYieldTagline",
    access: "DashboardEarn.deposit.profileYieldAccess",
  },
};

function ProfileCard({
  onSelect,
  selected,
  summary,
}: {
  onSelect: () => void;
  selected: boolean;
  summary: ProfileSummary;
}) {
  const t = useTranslations();
  const copy = PROFILE_COPY[summary.profile];
  const inputId = `earn-deposit-profile-${summary.profile}`;
  const nameId = `${inputId}-name`;
  const detailId = `${inputId}-detail`;

  return (
    <SelectableCard
      describedBy={detailId}
      inputId={inputId}
      labelledBy={nameId}
      name="earn-deposit-profile"
      onSelect={onSelect}
      selected={selected}
      value={summary.profile}
    >
      <span className="flex h-full flex-col">
        <span className="flex items-start justify-between gap-3">
          <span className="min-w-0">
            <span className="block text-base font-medium tracking-tight text-primary" id={nameId}>
              {t(copy.name)}
            </span>
            <span className="mt-1 block text-sm leading-5 text-secondary">{t(copy.tagline)}</span>
          </span>
          <SelectionMark selected={selected} />
        </span>

        {/* Same label-over-value grammar as the overview stat strip, pinned to
            one shared baseline across the three cards. The meta line carries
            the constraint that actually differentiates profiles when two tie
            on top APY — live figures, never marketing copy. A "—" rate is an
            empty profile stated plainly, not a fabricated number. */}
        <span className="mt-auto block border-t border-border-subtle pt-3">
          <span className="block text-[11px] font-medium tracking-[0.04em] text-tertiary uppercase">
            {t("DashboardEarn.deposit.profileTopApyLabel")}
          </span>
          <span className="mt-1 block text-2xl font-medium tracking-tight text-primary tabular-nums">
            {summary.topApy === undefined ? "—" : formatApy(String(summary.topApy))}
          </span>
          <span className="mt-1 block text-xs leading-5 text-tertiary" id={detailId}>
            {t("DashboardEarn.deposit.profileMeta", {
              count: summary.count,
              access: t(copy.access),
            })}
          </span>
        </span>
      </span>
    </SelectableCard>
  );
}

export function ProfileStep({
  hasError,
  isLoading,
  onSelect,
  selectedProfile,
  summaries,
}: {
  hasError: boolean;
  isLoading: boolean;
  onSelect: (profile: EarnDepositProfile) => void;
  selectedProfile: EarnDepositProfile | null;
  summaries: readonly ProfileSummary[];
}) {
  const t = useTranslations();
  const selected = summaries.find((summary) => summary.profile === selectedProfile);

  return (
    <div className="space-y-5">
      {isLoading ? <StepListSkeleton rowClassName="h-52 w-full rounded-2xl" /> : null}

      {hasError ? <StepNotice>{t("DashboardEarn.deposit.strategiesLoadError")}</StepNotice> : null}

      {!isLoading && !hasError ? (
        <fieldset className="grid items-stretch gap-3 lg:grid-cols-3">
          <legend className="sr-only">{t("DashboardEarn.deposit.profileTitle")}</legend>
          {summaries.map((summary) => (
            <ProfileCard
              key={summary.profile}
              onSelect={() => onSelect(summary.profile)}
              selected={summary.profile === selectedProfile}
              summary={summary}
            />
          ))}
        </fieldset>
      ) : null}

      <StepNote
        body={t("DashboardEarn.deposit.profileBasisBody")}
        icon={<InfoIcon className="size-5" />}
        title={t("DashboardEarn.deposit.profileBasisTitle")}
      />

      <SelectionAnnouncement>
        {selected ? t(PROFILE_COPY[selected.profile].name) : ""}
      </SelectionAnnouncement>
    </div>
  );
}
