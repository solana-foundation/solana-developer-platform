"use client";

import { Tab, TabList, Tabs } from "@solana/design-system/tabs";
import { useRouter } from "next/navigation";
import { useTransition } from "react";
import { SkeletonBlock } from "@/components/ui/skeleton-block";
import { useTranslations } from "@/i18n/provider";

export type PaymentsWorkspaceTab = "overview" | "playground";

export function PaymentsWorkspaceTabsSkeleton() {
  return (
    <div className="flex h-14 shrink-0 items-end gap-6 border-b border-border-default px-3 pb-3 md:px-6">
      <SkeletonBlock className="h-4 w-16" />
      <SkeletonBlock className="h-4 w-28" />
    </div>
  );
}

export function PaymentsWorkspaceTabs({
  value,
  onValueChange,
}: {
  value: PaymentsWorkspaceTab;
  onValueChange: (value: PaymentsWorkspaceTab) => void;
}) {
  const t = useTranslations();
  const tabs = [
    { id: "overview", label: t("Shared.tabs.overview") },
    { id: "playground", label: t("Shared.tabs.apiPlayground") },
  ] as const;

  return (
    <div
      className="flex h-14 shrink-0 items-end border-b border-border-default px-3 md:px-6"
      data-payments-workspace-tabs
    >
      <Tabs
        bordered={false}
        value={value}
        onValueChange={(nextValue) => {
          const nextTab = tabs.find((tab) => tab.id === nextValue);
          if (nextTab) onValueChange(nextTab.id);
        }}
      >
        <TabList>
          {tabs.map((tab) => (
            <Tab key={tab.id} value={tab.id}>
              {tab.label}
            </Tab>
          ))}
        </TabList>
      </Tabs>
    </div>
  );
}

export function PaymentsRouteTabs({
  basePath,
  value,
}: {
  basePath: string;
  value: PaymentsWorkspaceTab;
}) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();

  return (
    <div aria-busy={isPending}>
      <PaymentsWorkspaceTabs
        value={value}
        onValueChange={(nextValue) => {
          if (nextValue === value) return;
          startTransition(() => {
            router.push(nextValue === "playground" ? `${basePath}?tab=playground` : basePath);
          });
        }}
      />
    </div>
  );
}

export function PaymentsOverviewTabs({ value }: { value: PaymentsWorkspaceTab }) {
  return <PaymentsRouteTabs basePath="/dashboard/payments" value={value} />;
}
