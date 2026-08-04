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
 */
const PROFILE_COPY: Record<
  EarnDepositProfile,
  { name: MessageKey; tagline: MessageKey; detail: MessageKey }
> = {
  liquidity: {
    name: "DashboardEarn.deposit.profileLiquidityName",
    tagline: "DashboardEarn.deposit.profileLiquidityTagline",
    detail: "DashboardEarn.deposit.profileLiquidityDetail",
  },
  balanced: {
    name: "DashboardEarn.deposit.profileBalancedName",
    tagline: "DashboardEarn.deposit.profileBalancedTagline",
    detail: "DashboardEarn.deposit.profileBalancedDetail",
  },
  yield: {
    name: "DashboardEarn.deposit.profileYieldName",
    tagline: "DashboardEarn.deposit.profileYieldTagline",
    detail: "DashboardEarn.deposit.profileYieldDetail",
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
  const empty = summary.count === 0;

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
            <span className="mt-1 block text-sm font-medium text-secondary">{t(copy.tagline)}</span>
          </span>
          <SelectionMark selected={selected} />
        </span>

        {/* Live figures, not marketing copy: what the catalogue holds right now. */}
        <span className="mt-4 block text-2xl font-medium tracking-tight text-primary tabular-nums">
          {empty
            ? t("DashboardEarn.deposit.profileNoMatches")
            : summary.topApy === undefined
              ? t("DashboardEarn.deposit.profileCount", { count: summary.count })
              : t("DashboardEarn.deposit.profileTopApy", {
                  apy: formatApy(String(summary.topApy)),
                })}
        </span>
        {!empty && summary.topApy !== undefined ? (
          <span className="mt-1 block text-xs text-tertiary">
            {t("DashboardEarn.deposit.profileCount", { count: summary.count })}
          </span>
        ) : null}

        <span className="mt-3 block text-[13px] leading-5 text-secondary" id={detailId}>
          {t(copy.detail)}
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
        <fieldset className="grid gap-3 lg:grid-cols-3">
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
