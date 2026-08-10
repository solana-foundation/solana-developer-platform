import {
  Badge as SolanaBadge,
  type BadgeProps as SolanaBadgeProps,
} from "@solana/design-system/badge";

import { cn } from "@/lib/utils";

type BadgeVariant = "default" | "primary" | "success" | "warning" | "danger" | "info" | "outline";

type BadgeProps = Omit<SolanaBadgeProps, "variant"> & {
  variant?: BadgeVariant;
};

const variantClassNames: Record<BadgeVariant, string> = {
  default: "bg-fill text-primary",
  primary: "bg-primary text-on-primary",
  success: "bg-success-bg text-success",
  warning: "bg-warning-bg text-warning",
  danger: "bg-error-bg text-error",
  info: "bg-info-bg text-info",
  outline: "border border-border-default bg-transparent font-medium text-secondary",
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
