import { decimalScale } from "@sdp/solana/amount";
import { TextInput, type TextInputProps } from "@solana/design-system/text-input";
import { type ChangeEvent, cloneElement, isValidElement, type ReactNode } from "react";
import { cn } from "./cn";

type InputProps = TextInputProps & {
  /** Maximum fractional digits accepted while typing; changes beyond it are discarded. Null leaves input unconstrained. */
  maxDecimals?: number | null;
};

const DEFAULT_ICON_CLASS = "size-5 shrink-0 text-tertiary";

// An underline field: the design-system input tokens zero the radius, padding and focus ring, and
// the field draws only its bottom edge.
const UNDERLINE_FIELD_CLASS =
  "[&>span:first-child]:border-0 [&>span:first-child]:border-b-[length:var(--input-border-width)] [&>span:first-child]:bg-transparent";

function withIconClass(node: ReactNode): ReactNode {
  if (!isValidElement<{ className?: string }>(node)) {
    return node;
  }
  return cloneElement(node, {
    className: cn(DEFAULT_ICON_CLASS, node.props.className),
  });
}

/**
 * Design-system TextInput with the underline field style applied by default; callers can
 * override it through `className`.
 *
 * @param props - TextInput props; `className` merges after the underline style so conflicting utilities win.
 * @returns The styled text input element.
 */
function Input({
  className,
  size = "lg",
  iconLeft,
  iconRight,
  maxDecimals,
  onChange,
  ...props
}: InputProps) {
  const handleChange =
    maxDecimals === undefined || maxDecimals === null || onChange === undefined
      ? onChange
      : (event: ChangeEvent<HTMLInputElement>) => {
          if (decimalScale(event.currentTarget.value) <= maxDecimals) {
            onChange(event);
          }
        };

  return (
    <TextInput
      className={cn(UNDERLINE_FIELD_CLASS, stripWrapperPadding(className))}
      data-slot="input"
      size={size}
      iconLeft={withIconClass(iconLeft)}
      iconRight={withIconClass(iconRight)}
      onChange={handleChange}
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
