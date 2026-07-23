"use client";

import Image from "next/image";
import { useRouter } from "next/navigation";
import { useEffect } from "react";
import { useTranslations } from "@/i18n/provider";
import styles from "./organization-preparing-loader.module.css";

const ORGANIZATION_STATUS_REFRESH_MS = 2_000;

export function OrganizationPreparingLoader() {
  const t = useTranslations();
  const router = useRouter();

  useEffect(() => {
    const refreshTimer = window.setInterval(() => {
      router.refresh();
    }, ORGANIZATION_STATUS_REFRESH_MS);

    return () => window.clearInterval(refreshTimer);
  }, [router]);

  return (
    <div className="flex h-full items-center justify-center px-6 py-10">
      <section className="flex w-full max-w-xl flex-col items-center text-center">
        <div className={styles.stage} aria-hidden="true">
          <div className={styles.orbit} />
          <div className={styles.traveler}>
            <div className={styles.logoPlate}>
              <Image
                src="/landing/solana-logo.svg"
                alt=""
                width={42}
                height={38}
                className={`${styles.logo} dark:invert`}
                priority
              />
            </div>
          </div>
        </div>

        <h1 className="mt-7 text-balance text-[30px] leading-tight font-medium tracking-tight text-primary md:text-[36px]">
          {t("DashboardCustody.onboardingPreparingTitle")}
        </h1>
        <p className="mt-3 max-w-md text-sm leading-6 text-tertiary md:text-base">
          {t("DashboardCustody.onboardingPreparingDescription")}
        </p>
      </section>
    </div>
  );
}
