import {
  Button as SolanaButton,
  type ButtonProps as SolanaButtonProps,
} from "@solana/design-system/button";

import { cn } from "@/lib/utils";

type ButtonVariant = "default" | "destructive" | "outline" | "secondary" | "ghost" | "link";
type ButtonSize = "default" | "xs" | "sm" | "lg" | "icon" | "icon-xs" | "icon-sm" | "icon-lg";

type ButtonProps = Omit<SolanaButtonProps, "size" | "variant"> & {
  variant?: ButtonVariant;
  size?: ButtonSize;
};

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
  xs: "h-6 rounded-md px-2 text-xs [&_svg:not([class*='size-'])]:size-3",
  sm: undefined,
  lg: undefined,
  icon: "size-9",
  "icon-xs": "size-6 rounded-md [&_svg:not([class*='size-'])]:size-3",
  "icon-sm": "size-8",
  "icon-lg": "size-10",
};

function Button({
  className,
  variant = "default",
  size = "default",
  children,
  ...props
}: ButtonProps) {
  const isIconOnly = size.startsWith("icon");
  const solanaVariant: SolanaButtonProps["variant"] =
    variant === "default" || variant === "destructive" ? "primary" : "secondary";

  return (
    <SolanaButton
      data-variant={variant}
      data-size={size}
      iconLeft={isIconOnly ? children : props.iconLeft}
      iconOnly={isIconOnly}
      size={sizeMap[size]}
      variant={solanaVariant}
      className={cn(variantClassNames[variant], sizeClassNames[size], className)}
      {...props}
    >
      {isIconOnly ? null : children}
    </SolanaButton>
  );
}

export { Button };
