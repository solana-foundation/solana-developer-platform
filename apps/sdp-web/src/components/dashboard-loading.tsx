import { AppShell, PageBody, PageLayout } from "@/components/layouts";
import { getPageContentStyle, type PageWidth } from "@/components/layouts/page-layout";
import { SkeletonBlock } from "@/components/ui/skeleton-block";
import { cn } from "@/lib/utils";
import type { ReactNode } from "react";

type PageHeaderSkeletonVariant = "display" | "wide" | "narrow";

interface LoadingRegionProps {
  children: ReactNode;
  className?: string;
  label?: string;
}

interface PageHeaderSkeletonProps {
  variant: PageHeaderSkeletonVariant;
  titleWidthClassName?: string;
  action?: ReactNode;
  tabs?: boolean;
  backLink?: boolean;
  showTitleRow?: boolean;
  className?: string;
}

interface DashboardPageSkeletonLayoutProps {
  width?: PageWidth;
  header: ReactNode;
  children: ReactNode;
  className?: string;
  label?: string;
}

interface ToolbarSkeletonProps {
  actionWidthClassName?: string;
  className?: string;
}

interface TableCardSkeletonProps {
  titleWidthClassName?: string;
  descriptionWidthClassName?: string;
  rows?: number;
  headerAction?: ReactNode;
  className?: string;
  cardClassName?: string;
  rowHeightClassName?: string;
}

interface FormCardSkeletonProps {
  titleWidthClassName?: string;
  descriptionWidthClassName?: string;
  fields?: number;
  showNote?: boolean;
  className?: string;
}

interface SimpleCardSkeletonProps {
  titleWidthClassName?: string;
  lines?: number;
  className?: string;
}

function SurfaceCard({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div
      className={cn(
        "rounded-[20px] border border-[rgba(28,28,29,0.1)] bg-white shadow-none",
        className
      )}
    >
      {children}
    </div>
  );
}

function SidebarCollapseButtonSkeleton() {
  return (
    <SkeletonBlock className="h-[var(--layout-shell-collapse-button-size)] w-[var(--layout-shell-collapse-button-size)] rounded-lg" />
  );
}

export function SidebarOrgSwitcherSkeleton({ className }: { className?: string }) {
  return (
    <div
      className={cn(
        "relative flex max-w-[var(--layout-shell-top-control-max-width)] items-center gap-[var(--layout-shell-top-controls-gap)] rounded-[10px] border border-[rgba(28,28,29,0.08)] bg-white py-2 pr-3 pl-2 shadow-[0px_1px_3px_0px_rgba(0,0,0,0.1)]",
        className
      )}
    >
      <SkeletonBlock className="h-7 w-7 shrink-0 rounded-[6px]" />
      <SkeletonBlock className="h-4 min-w-0 flex-1 rounded-[4px]" />
      <SkeletonBlock className="h-6 w-6 shrink-0 rounded-full" />
      <div className="absolute inset-[-1px] pointer-events-none rounded-[inherit] shadow-[inset_0px_-1px_0px_0px_rgba(0,0,0,0.1)]" />
    </div>
  );
}

export function SidebarUserRowSkeleton({ className }: { className?: string }) {
  return (
    <div
      className={cn(
        "flex h-[var(--layout-shell-nav-row-height)] w-full items-center gap-[var(--layout-shell-nav-row-gap)] rounded-[var(--layout-shell-nav-row-radius)] p-[var(--layout-shell-nav-row-padding)]",
        className
      )}
    >
      <SkeletonBlock className="h-5 w-5 shrink-0 rounded-full" />
      <SkeletonBlock className="h-4 w-24 rounded-[4px]" />
    </div>
  );
}

export function SidebarSectionSkeleton({
  titleWidthClassName,
  rows,
  compact = false,
}: {
  titleWidthClassName: string;
  rows: number;
  compact?: boolean;
}) {
  return (
    <div className="flex flex-col gap-[var(--layout-shell-sidebar-section-title-gap)]">
      <SkeletonBlock className={cn("h-3 rounded-[4px]", titleWidthClassName)} />
      <div
        className={cn(
          "flex flex-col",
          compact
            ? "gap-[var(--layout-shell-sidebar-row-gap-compact)]"
            : "gap-[var(--layout-shell-sidebar-row-gap-default)]"
        )}
      >
        {Array.from({ length: rows }, (_, index) => (
          <SkeletonBlock
            key={`sidebar-row-${index + 1}`}
            className="h-[var(--layout-shell-nav-row-height)] w-full rounded-[12px]"
          />
        ))}
      </div>
    </div>
  );
}

function DashboardSidebarSkeleton() {
  return (
    <aside
      className="relative hidden overflow-hidden lg:sticky lg:top-0 lg:flex lg:h-screen lg:shrink-0"
      style={{
        width: "var(--layout-shell-sidebar-width)",
        maxWidth: "var(--layout-shell-sidebar-width)",
      }}
    >
      <div className="flex w-full max-w-[var(--layout-shell-sidebar-width)] shrink-0 flex-col justify-between bg-[#e9e7de]">
        <div className="flex flex-col gap-[var(--layout-shell-sidebar-top-gap)] px-[var(--layout-shell-sidebar-padding-inline)] py-[var(--layout-shell-sidebar-padding-block)]">
          <div className="flex items-center justify-between gap-[var(--layout-shell-top-controls-gap)]">
            <div className="min-w-0 max-w-[var(--layout-shell-top-control-max-width)] shrink">
              <SidebarOrgSwitcherSkeleton />
            </div>
            <SidebarCollapseButtonSkeleton />
          </div>
          <div className="flex flex-col gap-[var(--layout-shell-sidebar-sections-gap)]">
            <SidebarSectionSkeleton titleWidthClassName="w-12" rows={2} />
            <SidebarSectionSkeleton titleWidthClassName="w-14" rows={2} compact />
          </div>
        </div>
        <div className="px-[var(--layout-shell-sidebar-padding-inline)] py-[var(--layout-shell-sidebar-padding-block)]">
          <SidebarUserRowSkeleton />
        </div>
      </div>
    </aside>
  );
}

export function LoadingRegion({
  children,
  className,
  label = "Loading page",
}: LoadingRegionProps) {
  return (
    <div aria-busy="true" aria-label={label} className={cn("w-full", className)}>
      {children}
    </div>
  );
}

export function HeaderActionPairSkeleton() {
  return (
    <div className="flex flex-wrap items-center gap-3">
      <SkeletonBlock className="h-10 w-28 rounded-[10px]" />
      <SkeletonBlock className="h-10 w-32 rounded-[10px]" />
    </div>
  );
}

export function PageHeaderSkeleton({
  variant,
  titleWidthClassName = "w-36",
  action,
  tabs = false,
  backLink = false,
  showTitleRow = true,
  className,
}: PageHeaderSkeletonProps) {
  const contentStyle = getPageContentStyle();
  const shouldRenderTitleRow = showTitleRow;

  if (variant === "display") {
    return (
      <div className={className}>
        <div
          className="mx-auto flex w-full items-center justify-between gap-6 px-[var(--page-margin-sm)] pt-[128px]"
          style={contentStyle}
        >
          <SkeletonBlock className={cn("h-12 max-w-full", titleWidthClassName)} />
          {action}
        </div>
      </div>
    );
  }

  return (
    <div className={cn("bg-white", className)}>
      {shouldRenderTitleRow ? (
        <div className="mx-auto w-full px-[var(--page-margin-sm)]" style={contentStyle}>
          <div className="flex items-center justify-between gap-6 pt-[44px] pb-6">
            <SkeletonBlock className={cn("h-11 max-w-full", titleWidthClassName)} />
            {action}
          </div>
        </div>
      ) : null}
      {backLink ? (
        <div className="border-b-[1.5px] border-border-light">
          <div
            className={cn(
              "mx-auto w-full px-[var(--page-margin-sm)] pb-4",
              shouldRenderTitleRow ? "" : "pt-[44px]"
            )}
            style={contentStyle}
          >
            <SkeletonBlock className="h-4 w-32 rounded-[4px]" />
          </div>
        </div>
      ) : null}
      {tabs ? (
        <div className="border-b-[1.5px] border-border-light">
          <div className="mx-auto w-full px-[var(--page-margin-sm)]" style={contentStyle}>
            <div className="flex items-end gap-8 py-5">
              <SkeletonBlock className="h-6 w-24 rounded-[4px]" />
              <SkeletonBlock className="h-6 w-36 rounded-[4px]" />
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}

export function DashboardPageSkeletonLayout({
  width = "default",
  header,
  children,
  className,
  label,
}: DashboardPageSkeletonLayoutProps) {
  return (
    <PageLayout width={width}>
      {header}
      <PageBody>
        <LoadingRegion label={label} className={cn("space-y-6", className)}>
          {children}
        </LoadingRegion>
      </PageBody>
    </PageLayout>
  );
}

export function ToolbarSkeleton({
  actionWidthClassName = "w-32",
  className,
}: ToolbarSkeletonProps) {
  return (
    <div className={cn("flex flex-wrap items-center gap-3", className)}>
      <SkeletonBlock className="h-10 min-w-[240px] flex-1 rounded-[10px]" />
      <SkeletonBlock className={cn("h-10 rounded-[10px]", actionWidthClassName)} />
    </div>
  );
}

export function ActionPillsSkeleton() {
  return (
    <div className="flex flex-wrap gap-3">
      <SkeletonBlock className="h-10 w-24 rounded-full" />
      <SkeletonBlock className="h-10 w-28 rounded-full" />
    </div>
  );
}

export function MetricCardsSkeleton() {
  return (
    <div className="grid gap-4 md:grid-cols-2">
      {Array.from({ length: 2 }, (_, index) => (
        <SurfaceCard key={`metric-card-${index + 1}`} className="rounded-[18px]">
          <div className="space-y-4 px-6 py-6">
            <SkeletonBlock className="h-5 w-28 rounded-[4px]" />
            <SkeletonBlock className="h-10 w-40 rounded-[4px]" />
            <SkeletonBlock className="h-4 w-44 rounded-[4px]" />
          </div>
        </SurfaceCard>
      ))}
    </div>
  );
}

export function TableCardSkeleton({
  titleWidthClassName = "w-40",
  descriptionWidthClassName = "w-[46%]",
  rows = 5,
  headerAction,
  className,
  cardClassName,
  rowHeightClassName = "h-11",
}: TableCardSkeletonProps) {
  return (
    <div className={cn("space-y-4", className)}>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="space-y-2">
          <SkeletonBlock className={cn("h-8 rounded-[4px]", titleWidthClassName)} />
          <SkeletonBlock className={cn("h-4 rounded-[4px]", descriptionWidthClassName)} />
        </div>
        {headerAction}
      </div>
      <SurfaceCard className={cn("rounded-[20px]", cardClassName)}>
        <div className="space-y-3 px-6 py-6">
          {Array.from({ length: rows }, (_, index) => (
            <SkeletonBlock
              key={`table-row-${index + 1}`}
              className={cn("w-full rounded-[10px]", rowHeightClassName)}
            />
          ))}
        </div>
      </SurfaceCard>
    </div>
  );
}

export function FormCardSkeleton({
  titleWidthClassName = "w-44",
  descriptionWidthClassName = "w-[58%]",
  fields = 4,
  showNote = true,
  className,
}: FormCardSkeletonProps) {
  return (
    <SurfaceCard className={cn("rounded-[20px]", className)}>
      <div className="space-y-6 px-6 py-6">
        <div className="space-y-3">
          <SkeletonBlock className={cn("h-6 rounded-[4px]", titleWidthClassName)} />
          <SkeletonBlock className={cn("h-4 rounded-[4px]", descriptionWidthClassName)} />
        </div>
        <div className="space-y-5">
          {Array.from({ length: fields }, (_, index) => (
            <div key={`form-field-${index + 1}`} className="space-y-2">
              <SkeletonBlock className="h-4 w-28 rounded-[4px]" />
              <SkeletonBlock className="h-10 w-full rounded-[10px]" />
            </div>
          ))}
        </div>
        {showNote ? (
          <div className="rounded-xl border border-[rgba(28,28,29,0.12)] bg-[rgba(28,28,29,0.04)] px-3 py-3">
            <SkeletonBlock className="h-4 w-full rounded-[4px]" />
          </div>
        ) : null}
      </div>
    </SurfaceCard>
  );
}

export function SimpleCardSkeleton({
  titleWidthClassName = "w-32",
  lines = 2,
  className,
}: SimpleCardSkeletonProps) {
  return (
    <SurfaceCard className={cn("rounded-[20px]", className)}>
      <div className="space-y-4 px-6 py-6">
        <SkeletonBlock className={cn("h-6 rounded-[4px]", titleWidthClassName)} />
        <div className="space-y-3">
          {Array.from({ length: lines }, (_, index) => (
            <SkeletonBlock
              key={`simple-line-${index + 1}`}
              className={cn("h-4 rounded-[4px]", index === lines - 1 ? "w-[68%]" : "w-full")}
            />
          ))}
        </div>
      </div>
    </SurfaceCard>
  );
}

export function SectionTabsSkeleton() {
  return (
    <div className="flex flex-wrap gap-3">
      {["w-24", "w-28", "w-28", "w-24", "w-24", "w-36"].map((widthClassName, index) => (
        <SkeletonBlock
          key={`section-tab-${index + 1}`}
          className={cn("h-9 rounded-full", widthClassName)}
        />
      ))}
    </div>
  );
}

export function TokenManagementHeroSkeleton() {
  return (
    <div className="space-y-8">
      <div className="flex flex-col gap-6 lg:flex-row lg:items-end lg:justify-between">
        <div className="flex min-w-0 items-start gap-4">
          <SkeletonBlock className="h-14 w-14 rounded-full" />
          <div className="min-w-0 space-y-3">
            <SkeletonBlock className="h-12 w-64 max-w-full rounded-[4px]" />
            <div className="flex flex-wrap items-center gap-2">
              <SkeletonBlock className="h-5 w-28 rounded-[4px]" />
              <SkeletonBlock className="h-8 w-8 rounded-[10px]" />
              <SkeletonBlock className="h-8 w-16 rounded-full" />
            </div>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <SkeletonBlock className="h-10 w-28 rounded-[10px]" />
          <SkeletonBlock className="h-10 w-24 rounded-[10px]" />
          <SkeletonBlock className="h-10 w-24 rounded-[10px]" />
        </div>
      </div>
      <SectionTabsSkeleton />
    </div>
  );
}

export function DashboardShellSkeleton() {
  return (
    <AppShell sidebar={<DashboardSidebarSkeleton />}>
      <DashboardPageSkeletonLayout
        width="default"
        label="Loading dashboard"
        className="space-y-8 py-2"
        header={
          <PageHeaderSkeleton
            variant="display"
            titleWidthClassName="w-32"
            action={<HeaderActionPairSkeleton />}
          />
        }
      >
        <MetricCardsSkeleton />
        <TableCardSkeleton
          titleWidthClassName="w-56"
          descriptionWidthClassName="w-72"
          rows={6}
          headerAction={<SkeletonBlock className="h-9 w-24 rounded-[10px]" />}
        />
      </DashboardPageSkeletonLayout>
    </AppShell>
  );
}
