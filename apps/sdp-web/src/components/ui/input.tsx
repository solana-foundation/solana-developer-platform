import { TextInput, type TextInputProps } from "@solana/design-system/text-input";

type InputProps = Omit<TextInputProps, "size">;

function Input({ className, ...props }: InputProps) {
  return (
    <TextInput className={stripWrapperPadding(className)} data-slot="input" size="lg" {...props} />
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
