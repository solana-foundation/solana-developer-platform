import { TextInput } from "@solana/design-system/text-input";
import type * as React from "react";

type InputProps = Omit<React.ComponentProps<"input">, "size">;

function Input({ className, ...props }: InputProps) {
  return <TextInput className={className} data-slot="input" size="lg" {...props} />;
}

export { Input };
