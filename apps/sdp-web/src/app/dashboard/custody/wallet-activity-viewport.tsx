"use client";

import { useEffect, useRef, useState } from "react";
import { WalletActivitySection } from "@/app/dashboard/custody/wallet-activity-section";
import {
  WALLET_ACTIVITY_HEADING_ID,
  WalletActivitySkeleton,
} from "@/app/dashboard/custody/wallet-activity-skeleton";
import { useTranslations } from "@/i18n/provider";

export const WALLET_ACTIVITY_ROOT_MARGIN = "256px 0px";

interface WalletActivityViewportContentProps {
  isVisible: boolean;
  isNearViewport: boolean;
  walletId: string;
}

export function WalletActivityViewportContent({
  isVisible,
  isNearViewport,
  walletId,
}: WalletActivityViewportContentProps) {
  const t = useTranslations();

  if (isNearViewport) {
    return (
      <div data-wallet-activity-loader="mounted">
        <WalletActivitySection walletId={walletId} isVisible={isVisible} />
      </div>
    );
  }

  return (
    <WalletActivitySkeleton
      title={t("DashboardCustody.recentActivity")}
      description={t("DashboardCustody.recentActivityDescription")}
      headingId={WALLET_ACTIVITY_HEADING_ID}
    />
  );
}

export function WalletActivityViewport({ walletId }: { walletId: string }) {
  const regionRef = useRef<HTMLElement>(null);
  const [isNearViewport, setIsNearViewport] = useState(false);
  const [isVisible, setIsVisible] = useState(false);

  useEffect(() => {
    const region = regionRef.current;
    if (!region) return;

    if (!("IntersectionObserver" in window)) {
      setIsNearViewport(true);
      setIsVisible(true);
      return;
    }

    const loadObserver = new IntersectionObserver(
      (entries) => {
        if (!entries.some((entry) => entry.isIntersecting)) return;

        loadObserver.disconnect();
        setIsNearViewport(true);
      },
      { rootMargin: WALLET_ACTIVITY_ROOT_MARGIN }
    );
    const visibilityObserver = new IntersectionObserver((entries) => {
      const nextIsVisible = entries.some((entry) => entry.isIntersecting);
      setIsVisible(nextIsVisible);
      if (nextIsVisible) setIsNearViewport(true);
    });

    loadObserver.observe(region);
    visibilityObserver.observe(region);
    return () => {
      loadObserver.disconnect();
      visibilityObserver.disconnect();
    };
  }, []);

  return (
    <section
      ref={regionRef}
      id="recent-activity"
      aria-labelledby={WALLET_ACTIVITY_HEADING_ID}
      className="scroll-mt-6"
      data-wallet-activity-state={isNearViewport ? "mounted" : "deferred"}
      data-wallet-activity-visible={isVisible ? "true" : "false"}
    >
      <WalletActivityViewportContent
        isNearViewport={isNearViewport}
        isVisible={isVisible}
        walletId={walletId}
      />
    </section>
  );
}
