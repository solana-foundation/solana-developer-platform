import { type ReactNode } from "react";
import { cn } from "@/lib/utils";
import { ArrowLeft } from "lucide-react";
import Link from "next/link";
import { getPageContentStyle } from "./page-layout";

const headerSpacingClassNames = {
  displayContainer:
    "px-[var(--layout-page-header-display-inset)] pt-[var(--layout-page-header-display-padding-top)]",
  defaultInset: "px-[var(--layout-page-header-default-inset)]",
  titleRow:
    "pt-[var(--layout-page-header-title-padding-top)] pb-[var(--layout-page-header-title-padding-bottom)]",
  secondaryRow: "pb-[var(--layout-page-header-secondary-padding-bottom)]",
  secondaryRowWithoutTitle: "pt-[var(--layout-page-header-title-padding-top)]",
} as const;

interface PageHeaderProps {
  variant: "display" | "wide" | "narrow";
  title?: string;
  action?: ReactNode;
  tabs?: ReactNode;
  backLink?: { href: string; label: string };
  className?: string;
}

export function PageHeader({ variant, title, action, tabs, backLink, className }: PageHeaderProps) {
  const contentStyle = getPageContentStyle();
  const shouldRenderTitleRow = Boolean(title) || Boolean(action);

  if (variant === "display") {
    return (
      <div className={className}>
        <div
          className={cn(
            "mx-auto flex w-full items-center justify-between",
            headerSpacingClassNames.displayContainer
          )}
          style={contentStyle}
        >
          {title ? <h1 className="text-title-lg text-text-extra-high">{title}</h1> : <div />}
          {action}
        </div>
      </div>
    );
  }

  return (
    <div className={cn("bg-white", className)}>
      {shouldRenderTitleRow ? (
        <div
          className={cn("mx-auto w-full", headerSpacingClassNames.defaultInset)}
          style={contentStyle}
        >
          <div className={cn("flex items-center justify-between", headerSpacingClassNames.titleRow)}>
            {title ? <h1 className="text-title-lg text-text-extra-high">{title}</h1> : <div />}
            {action}
          </div>
        </div>
      ) : null}
      {backLink ? (
        <div className="border-b-[1.5px] border-border-light">
          <div
            className={cn(
              "mx-auto w-full",
              headerSpacingClassNames.defaultInset,
              headerSpacingClassNames.secondaryRow,
              shouldRenderTitleRow ? "" : headerSpacingClassNames.secondaryRowWithoutTitle
            )}
            style={contentStyle}
          >
            <Link
              href={backLink.href}
              className="inline-flex h-7 items-center gap-1.5 rounded-[8px] text-[rgba(28,28,29,0.72)] transition-colors hover:text-[#1c1c1d]"
            >
              <ArrowLeft className="h-4 w-4" />
              <span className="text-[13px] leading-[18px] font-medium">{backLink.label}</span>
            </Link>
          </div>
        </div>
      ) : tabs ? (
        <div className="border-b-[1.5px] border-border-light">
          <div
            className={cn("mx-auto w-full", headerSpacingClassNames.defaultInset)}
            style={contentStyle}
          >
            {tabs}
          </div>
        </div>
      ) : null}
    </div>
  );
}
