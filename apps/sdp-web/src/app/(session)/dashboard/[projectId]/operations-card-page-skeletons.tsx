import { SkeletonBlock } from "@sdp/ui/skeleton-block";
import type { ReactNode } from "react";

export function CompactOperationsCardSkeleton({ route }: { route: "allowlist" }) {
  return (
    <div
      className="flex w-full max-w-5xl flex-col gap-6"
      data-loading-layout={route}
      aria-busy="true"
    >
      <section className="flex flex-col gap-6 rounded-[var(--sdp-surface-radius)] bg-surface-raised py-6 shadow-sm ring-1 ring-border-default">
        <header className="px-6">
          <SkeletonBlock className="h-6 w-44 max-w-full" />
        </header>
        <div className="px-6">
          <SkeletonBlock className="h-4 w-full max-w-xl" />
          <SkeletonBlock className="mt-2 h-4 w-3/5 max-w-md" />
        </div>
      </section>
    </div>
  );
}

export function AccountPageSkeleton() {
  return (
    <div className="flex w-full flex-col gap-6" data-loading-layout="account" aria-busy="true">
      {[0, 1].map((index) => (
        <section
          key={index}
          className="flex flex-col gap-6 rounded-[var(--sdp-surface-radius)] bg-surface-raised py-6 shadow-sm ring-1 ring-border-default"
        >
          <header className="space-y-2 px-6">
            <SkeletonBlock className="h-6 w-32" />
            <SkeletonBlock className="h-4 w-full max-w-md" />
          </header>
          <div className="space-y-3 px-6">
            <SkeletonBlock className="h-10 w-full" />
            <SkeletonBlock className="h-10 w-full" />
          </div>
        </section>
      ))}
    </div>
  );
}

/** The Send feedback form: the category control, the message box and the action row. */
export function FeedbackPageSkeleton() {
  return (
    <div className="flex w-full flex-col gap-6" data-loading-layout="feedback" aria-busy="true">
      <div className="flex flex-col gap-2">
        <SkeletonBlock className="h-4 w-32" />
        <SkeletonBlock className="h-9 w-80 max-w-full rounded-control" />
      </div>
      <div className="flex flex-col gap-2">
        <SkeletonBlock className="h-4 w-40" />
        <SkeletonBlock className="h-36 w-full rounded-xl" />
      </div>
      <div className="flex justify-end gap-2">
        <SkeletonBlock className="h-9 w-20" />
        <SkeletonBlock className="h-9 w-36" />
      </div>
    </div>
  );
}

function SettingsSectionSkeleton({
  titleWidth,
  aside,
  children,
  ...attributes
}: {
  titleWidth: string;
  aside?: ReactNode;
  children: ReactNode;
  "data-loading-settings-onboarding"?: true;
}) {
  return (
    <section {...attributes} className="flex flex-col gap-3.5 pt-5.5">
      <div className="flex h-8 items-center justify-between gap-3">
        <SkeletonBlock className={`h-5 ${titleWidth}`} />
        {aside}
      </div>
      <div className="flex flex-col">{children}</div>
    </section>
  );
}

function SettingsRecordRowSkeleton({ valueWidth }: { valueWidth: string }) {
  return (
    <div className="flex items-center justify-between gap-4 border-b border-border-subtle py-2.5 last:border-b-0">
      <SkeletonBlock className="my-0.5 h-4 w-20" />
      <SkeletonBlock className={`my-0.5 h-4 max-w-full ${valueWidth}`} />
    </div>
  );
}

function SettingsActionRowSkeleton({ control }: { control: ReactNode }) {
  return (
    <div className="flex flex-col gap-3 border-b border-border-subtle py-3 last:border-b-0 @xl:flex-row @xl:items-center @xl:justify-between @xl:gap-6">
      <div className="flex min-w-0 flex-col gap-1">
        <SkeletonBlock className="my-0.5 h-4 w-28" />
        <SkeletonBlock className="h-4 w-56 max-w-full" />
      </div>
      {control}
    </div>
  );
}

export function SettingsPageSkeleton() {
  return (
    <div
      className="@container flex w-full flex-col gap-2.5"
      data-loading-layout="settings"
      aria-busy="true"
    >
      <SettingsSectionSkeleton titleWidth="w-16">
        <SettingsRecordRowSkeleton valueWidth="w-32" />
        <SettingsRecordRowSkeleton valueWidth="w-48" />
      </SettingsSectionSkeleton>
      <SettingsSectionSkeleton titleWidth="w-24" data-loading-settings-onboarding>
        <SettingsActionRowSkeleton
          control={<SkeletonBlock className="h-control-lg w-28 shrink-0 rounded-control" />}
        />
      </SettingsSectionSkeleton>
      <SettingsSectionSkeleton
        titleWidth="w-20"
        aside={<SkeletonBlock className="h-control-md w-32 shrink-0 rounded-control" />}
      >
        <SettingsRecordRowSkeleton valueWidth="w-28" />
        <SettingsRecordRowSkeleton valueWidth="w-40" />
      </SettingsSectionSkeleton>
      <SettingsSectionSkeleton titleWidth="w-28">
        <SettingsActionRowSkeleton
          control={<SkeletonBlock className="h-6 w-11 shrink-0 rounded-full" />}
        />
      </SettingsSectionSkeleton>
    </div>
  );
}
