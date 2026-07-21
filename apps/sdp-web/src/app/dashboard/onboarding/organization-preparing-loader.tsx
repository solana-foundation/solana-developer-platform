"use client";

import { Sparkles } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { useTranslations } from "@/i18n/provider";
import styles from "./organization-preparing-loader.module.css";

const ORGANIZATION_STATUS_REFRESH_MS = 2_000;

export function OrganizationPreparingLoader() {
  const t = useTranslations();
  const router = useRouter();
  const [score, setScore] = useState(0);

  useEffect(() => {
    const refreshTimer = window.setInterval(() => {
      router.refresh();
    }, ORGANIZATION_STATUS_REFRESH_MS);

    return () => window.clearInterval(refreshTimer);
  }, [router]);

  return (
    <div className="flex h-full items-center justify-center px-6 py-10">
      <section className="flex w-full max-w-xl flex-col items-center text-center">
        <div className={styles.game}>
          <button
            type="button"
            className={styles.spark}
            aria-label={t("DashboardCustody.onboardingPreparingCatch")}
            onClick={() => setScore((current) => current + 1)}
          >
            <Sparkles className={styles.sparkIcon} aria-hidden="true" />
          </button>
        </div>

        <p
          className="mt-5 text-xs font-medium tracking-[0.12em] text-muted uppercase"
          aria-live="polite"
        >
          {t("DashboardCustody.onboardingPreparingScore", { count: score })}
        </p>
        <h1 className="mt-6 text-balance text-[30px] leading-tight font-medium tracking-tight text-primary md:text-[36px]">
          {t("DashboardCustody.onboardingPreparingTitle")}
        </h1>
        <p className="mt-3 max-w-md text-sm leading-6 text-tertiary md:text-base">
          {t("DashboardCustody.onboardingPreparingDescription")}
        </p>
      </section>
    </div>
  );
}
