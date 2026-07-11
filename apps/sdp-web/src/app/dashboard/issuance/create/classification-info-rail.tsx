"use client";

import { Braces, Hexagon, Link2, Lock, type LucideIcon, Target } from "lucide-react";
import { useTranslations } from "@/i18n/provider";

interface InfoStep {
  icon: LucideIcon;
  titleKey: "assetProfile" | "issuanceMetadata" | "publicProjection" | "tokenMetadataUri";
  descriptionKey: "assetProfileDescription" | "issuanceMetadataDescription" | "publicProjectionDescription" | "tokenMetadataUriDescription";
}

// Explains the Asset Profile data model (profile -> metadata -> public
// projection -> token URI) alongside the classification step.
const STEPS: InfoStep[] = [
  {
    icon: Hexagon,
    titleKey: "assetProfile",
    descriptionKey: "assetProfileDescription",
  },
  {
    icon: Braces,
    titleKey: "issuanceMetadata",
    descriptionKey: "issuanceMetadataDescription",
  },
  {
    icon: Target,
    titleKey: "publicProjection",
    descriptionKey: "publicProjectionDescription",
  },
  {
    icon: Link2,
    titleKey: "tokenMetadataUri",
    descriptionKey: "tokenMetadataUriDescription",
  },
];

export function ClassificationInfoRail() {
  const t = useTranslations();
  return (
    <aside className="lg:sticky lg:top-4">
      <div className="rounded-2xl border border-[rgba(28,28,29,0.1)] bg-white p-5">
        <p className="text-base font-medium text-[#1c1c1d]">{t("DashboardIssuance.classificationRail.title")}</p>

        <ul className="mt-4 space-y-4">
          {STEPS.map((step) => {
            const Icon = step.icon;
            return (
            <li key={step.titleKey} className="flex items-center gap-3">
                <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-[rgba(28,28,29,0.05)] text-[rgba(28,28,29,0.7)]">
                  <Icon className="h-4 w-4" />
                </span>
                <div className="min-w-0">
                  <p className="text-sm font-medium text-[#1c1c1d]">{t(`DashboardIssuance.classificationRail.${step.titleKey}`)}</p>
                  <p className="mt-0.5 text-sm text-[rgba(28,28,29,0.58)]">{t(`DashboardIssuance.classificationRail.${step.descriptionKey}`)}</p>
                </div>
              </li>
            );
          })}
        </ul>

        <div className="mt-5 flex items-start gap-2.5 rounded-xl border border-[rgba(28,28,29,0.08)] bg-[rgba(28,28,29,0.02)] p-3">
          <Lock className="mt-0.5 h-4 w-4 shrink-0 text-[rgba(28,28,29,0.5)]" />
          <div className="min-w-0">
            <p className="text-sm font-semibold text-[#1c1c1d]">{t("DashboardIssuance.summary.privateByDefault")}</p>
            <p className="mt-0.5 text-xs text-[rgba(28,28,29,0.58)]">
              {t("DashboardIssuance.classificationRail.privateDescription")}
            </p>
          </div>
        </div>
      </div>
    </aside>
  );
}
