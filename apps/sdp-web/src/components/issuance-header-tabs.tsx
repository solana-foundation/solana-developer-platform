"use client";

import { Tab, TabList, Tabs } from "@solana/design-system/tabs";
import { useEffect, useState } from "react";
import { useDashboardWorkspace } from "@/contexts/dashboard-workspace-context";
import { useTranslations } from "@/i18n/provider";

export function IssuanceHeaderTabs() {
  const { issuanceTab, setIssuanceTab } = useDashboardWorkspace();
  const [isMobile, setIsMobile] = useState(false);
  const t = useTranslations();
  const tabOptions = [
    { id: "tokens", label: t("Shared.tabs.overview") },
    { id: "playground", label: t("Shared.tabs.apiPlayground") },
  ] as const;

  useEffect(() => {
    const mediaQuery = window.matchMedia("(max-width: 767px)");
    const updateIsMobile = () => setIsMobile(mediaQuery.matches);

    updateIsMobile();
    mediaQuery.addEventListener("change", updateIsMobile);

    return () => mediaQuery.removeEventListener("change", updateIsMobile);
  }, []);

  useEffect(() => {
    if (isMobile && issuanceTab === "playground") {
      setIssuanceTab("tokens");
    }
  }, [isMobile, issuanceTab, setIssuanceTab]);

  if (isMobile) {
    return null;
  }

  return (
    <Tabs
      bordered
      onValueChange={(value) => {
        const nextTab = tabOptions.find((tab) => tab.id === value);
        if (nextTab) {
          setIssuanceTab(nextTab.id);
        }
      }}
      value={issuanceTab}
    >
      <TabList>
        {tabOptions.map((tab) => (
          <Tab key={tab.id} value={tab.id}>
            {tab.label}
          </Tab>
        ))}
      </TabList>
    </Tabs>
  );
}
