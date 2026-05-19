import {
  Badge as SolanaBadge,
  type BadgeProps as SolanaBadgeProps,
} from "@solana/design-system/badge";

import { cn } from "@/lib/utils";

type BadgeVariant = "default" | "success" | "warning" | "danger" | "info";

type BadgeProps = Omit<SolanaBadgeProps, "variant"> & {
  variant?: BadgeVariant;
};

const variantClassNames: Record<BadgeVariant, string> = {
  default: "bg-[rgba(28,28,29,0.08)] text-text-extra-high",
  success: "bg-status-success-bg text-status-success-text",
  warning: "bg-status-warning-bg text-status-warning-text",
  danger: "bg-status-error-bg text-status-error-text",
  info: "bg-[var(--sdp-color-info-bg)] text-[color:var(--sdp-color-info-text)]",
};

function Badge({ className, variant = "default", ...props }: BadgeProps) {
  return (
    <SolanaBadge
      data-variant={variant}
      variant="default"
      className={cn("!rounded-sm font-semibold", variantClassNames[variant], className)}
      {...props}
    />
  );
}

export type { BadgeProps, BadgeVariant };
export { Badge };
