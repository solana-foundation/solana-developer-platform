import { cn } from "@/lib/utils";
import type { CSSProperties, ReactNode } from "react";

export const pageWidthValues = {
  narrow: "48rem",
  default: "64rem",
  wide: "80rem",
  full: "none",
} as const;

export type PageWidth = keyof typeof pageWidthValues;

export const pageInsetValues = {
  default: "var(--layout-page-header-default-inset)",
  display: "var(--layout-page-header-display-inset)",
} as const;

export type PageInset = keyof typeof pageInsetValues;

const DEFAULT_PAGE_WIDTH = pageWidthValues.default;

export function getPageLayoutStyle(width: PageWidth, inset: PageInset): CSSProperties {
  return {
    "--page-layout-max-width": pageWidthValues[width],
    "--page-layout-inline-padding": pageInsetValues[inset],
  } as CSSProperties;
}

export function getPageContentStyle(): CSSProperties {
  return {
    maxWidth: `var(--page-layout-max-width, ${DEFAULT_PAGE_WIDTH})`,
  };
}

interface PageLayoutProps {
  width?: PageWidth;
  inset?: PageInset;
  children: ReactNode;
  className?: string;
}

export function PageLayout({
  width = "default",
  inset = "default",
  children,
  className,
}: PageLayoutProps) {
  return (
    <div
      className={cn("flex min-h-0 flex-1 flex-col", className)}
      style={getPageLayoutStyle(width, inset)}
    >
      {children}
    </div>
  );
}
