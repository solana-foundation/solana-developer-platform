import { TextInput, type TextInputProps } from "@solana/design-system/text-input";
import { cloneElement, isValidElement, type ReactNode } from "react";
import { cn } from "@/lib/utils";

type InputProps = TextInputProps;

const DEFAULT_ICON_CLASS = "size-5 shrink-0 text-text-low";

function withIconClass(node: ReactNode): ReactNode {
  if (!isValidElement<{ className?: string }>(node)) {
    return node;
  }
  return cloneElement(node, {
    className: cn(DEFAULT_ICON_CLASS, node.props.className),
  });
}

function Input({ className, size = "lg", iconLeft, iconRight, ...props }: InputProps) {
  return (
    <TextInput
      className={stripWrapperPadding(className)}
      data-slot="input"
      size={size}
      iconLeft={withIconClass(iconLeft)}
      iconRight={withIconClass(iconRight)}
      {...props}
    />
  );
}

export { Input };

function stripWrapperPadding(className: string | undefined) {
  if (!className) {
    return className;
  }

  const classNames = className
    .split(/\s+/)
    .filter((token) => {
      const utility = token.split(":").pop() ?? token;
      return !/^!?p(?:x)?-/.test(utility);
    })
    .join(" ");

  return classNames || undefined;
}
