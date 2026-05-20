import {
  Button as SolanaButton,
  type ButtonProps as SolanaButtonProps,
} from "@solana/design-system/button";
import { Slot } from "@solana/design-system/utils";
import type { ComponentProps } from "react";

import { cn } from "@/lib/utils";

type ButtonVariant = "default" | "destructive" | "outline" | "secondary" | "ghost" | "link";
type ButtonSize = "default" | "xs" | "sm" | "lg" | "icon" | "icon-xs" | "icon-sm" | "icon-lg";

type ButtonProps = Omit<SolanaButtonProps, "size" | "variant"> & {
  variant?: ButtonVariant;
  size?: ButtonSize;
};

const slotBaseClassName =
  "relative inline-flex shrink-0 items-center justify-center whitespace-nowrap font-medium no-underline transition-colors duration-150 ease-out focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--button-focus-ring)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--gray-50)] disabled:pointer-events-none disabled:opacity-40";

const variantClassNames: Record<ButtonVariant, string | undefined> = {
  default: undefined,
  destructive:
    "bg-status-error-text text-white hover:bg-status-error-text focus-visible:ring-status-error-border",
  outline: "border border-border-light bg-white text-text-extra-high hover:bg-gray-100",
  secondary: undefined,
  ghost: "bg-transparent text-text-medium hover:bg-border-extra-light hover:text-text-extra-high",
  link: "h-auto bg-transparent px-0 text-text-extra-high underline-offset-4 hover:bg-transparent hover:underline",
};

const sizeMap: Record<ButtonSize, NonNullable<SolanaButtonProps["size"]>> = {
  default: "lg",
  xs: "sm",
  sm: "md",
  lg: "lg",
  icon: "md",
  "icon-xs": "sm",
  "icon-sm": "sm",
  "icon-lg": "lg",
};

const sizeClassNames: Record<ButtonSize, string | undefined> = {
  default: undefined,
  // biome-ignore lint/security/noSecrets: Tailwind arbitrary selector utility, not a secret.
  xs: "h-6 rounded-md px-2 text-xs [&_svg:not([class*='size-'])]:size-3",
  sm: undefined,
  lg: undefined,
  icon: "size-9",
  // biome-ignore lint/security/noSecrets: Tailwind arbitrary selector utility, not a secret.
  "icon-xs": "size-6 rounded-md [&_svg:not([class*='size-'])]:size-3",
  "icon-sm": "size-8",
  "icon-lg": "size-10",
};

const slotVariantClassNames: Record<ButtonVariant, string> = {
  default: "bg-[#0f0f10] !text-white hover:bg-black hover:!text-white visited:!text-white",
  destructive:
    "bg-status-error-text text-white hover:bg-status-error-text focus-visible:ring-status-error-border",
  outline: "border border-border-light bg-white text-text-extra-high hover:bg-gray-100",
  secondary: "bg-[rgba(28,28,29,0.08)] text-[#1c1c1d] hover:bg-[rgba(28,28,29,0.14)]",
  ghost: "bg-transparent text-text-medium hover:bg-border-extra-light hover:text-text-extra-high",
  link: "h-auto bg-transparent px-0 text-text-extra-high underline-offset-4 hover:bg-transparent hover:underline",
};

const slotSizeClassNames: Record<ButtonSize, string> = {
  default:
    "h-[var(--button-height-lg)] gap-[var(--button-gap-lg)] rounded-[var(--button-radius-lg)] px-[var(--button-padding-x-lg)] text-button-lg",
  // biome-ignore lint/security/noSecrets: Tailwind arbitrary selector utility, not a secret.
  xs: "h-6 gap-1 rounded-md px-2 text-xs [&_svg:not([class*='size-'])]:size-3",
  sm: "h-[var(--button-height-md)] gap-[var(--button-gap-md)] rounded-[var(--button-radius-md)] px-[var(--button-padding-x-md)] text-button-md",
  lg: "h-[var(--button-height-lg)] gap-[var(--button-gap-lg)] rounded-[var(--button-radius-lg)] px-[var(--button-padding-x-lg)] text-button-lg",
  icon: "size-9 rounded-[var(--button-radius-md)] p-0",
  // biome-ignore lint/security/noSecrets: Tailwind arbitrary selector utility, not a secret.
  "icon-xs": "size-6 rounded-md p-0 [&_svg:not([class*='size-'])]:size-3",
  "icon-sm": "size-8 rounded-[var(--button-radius-sm)] p-0",
  "icon-lg": "size-10 rounded-[var(--button-radius-lg)] p-0",
};

function Button({
  className,
  variant = "default",
  size = "default",
  children,
  iconLeft,
  iconRight,
  asChild,
  ...props
}: ButtonProps) {
  const isIconOnly = size.startsWith("icon");
  const solanaVariant: SolanaButtonProps["variant"] =
    variant === "default" || variant === "destructive" ? "primary" : "secondary";

  if (asChild) {
    const slotProps = props as ComponentProps<typeof Slot>;

    return (
      <Slot
        {...slotProps}
        data-variant={variant}
        data-size={size}
        className={cn(
          slotBaseClassName,
          slotVariantClassNames[variant],
          slotSizeClassNames[size],
          className
        )}
      >
        {children}
      </Slot>
    );
  }

  return (
    <SolanaButton
      data-variant={variant}
      data-size={size}
      iconOnly={isIconOnly}
      size={sizeMap[size]}
      variant={solanaVariant}
      className={cn(variantClassNames[variant], sizeClassNames[size], className)}
      {...props}
      iconLeft={isIconOnly ? children : iconLeft}
      iconRight={isIconOnly ? undefined : iconRight}
    >
      {isIconOnly ? null : children}
    </SolanaButton>
  );
}

export { Button };
