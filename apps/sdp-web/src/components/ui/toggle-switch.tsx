import type { ComponentPropsWithoutRef } from "react";
import { cn } from "@/lib/utils";

type ToggleSwitchProps = Omit<ComponentPropsWithoutRef<"button">, "onChange"> & {
  checked: boolean;
  onChange: (checked: boolean) => void;
};

export function ToggleSwitch({
  checked,
  onChange,
  disabled,
  className,
  ...props
}: ToggleSwitchProps) {
  return (
    <button
      {...props}
      type="button"
      role="switch"
      data-sdp-toggle-switch
      aria-checked={checked}
      data-state={checked ? "checked" : "unchecked"}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={cn(
        "relative h-6 w-11 shrink-0 rounded-full outline-none transition-colors focus-visible:ring-2 focus-visible:ring-border-strong focus-visible:ring-offset-2 focus-visible:ring-offset-surface-raised disabled:cursor-not-allowed disabled:opacity-40 motion-reduce:transition-none",
        checked ? "bg-primary" : "bg-border-strong",
        className
      )}
    >
      <span
        className={cn(
          "absolute top-0.5 left-0.5 h-5 w-5 rounded-full bg-surface-raised shadow transition-transform motion-reduce:transition-none",
          checked ? "translate-x-5" : "translate-x-0"
        )}
      />
    </button>
  );
}
