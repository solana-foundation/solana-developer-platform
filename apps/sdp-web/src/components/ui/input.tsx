import { TextInput, type TextInputProps } from "@solana/design-system/text-input";

type InputProps = TextInputProps;

function Input({ className, size = "lg", ...props }: InputProps) {
  return (
    <TextInput
      className={stripWrapperPadding(className)}
      data-slot="input"
      size={size}
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
