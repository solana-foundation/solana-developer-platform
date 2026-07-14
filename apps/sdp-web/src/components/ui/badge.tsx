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
  default: "bg-fill text-primary",
  success: "bg-success-bg text-success",
  warning: "bg-warning-bg text-warning",
  danger: "bg-error-bg text-error",
  info: "bg-info-bg text-info",
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
