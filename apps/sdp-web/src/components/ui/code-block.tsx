"use client";

import { Check, Clipboard } from "lucide-react";
import type { ComponentProps, ReactNode } from "react";
import { useTranslations } from "@/i18n/provider";
import { useCopy } from "@/lib/use-copy";
import { cn } from "@/lib/utils";

interface CodeBlockProps extends Omit<ComponentProps<"figure">, "children" | "title"> {
  code: string;
  language?: string;
  title?: ReactNode;
  viewportClassName?: string;
}

/** A copyable, scrollable code surface adapted from the docs code block. */
export function CodeBlock({
  code,
  language,
  title,
  className,
  viewportClassName,
  ...props
}: CodeBlockProps) {
  const t = useTranslations();
  const { copied, copy } = useCopy(1200);
  const copyButton = (
    <button
      type="button"
      aria-label={
        copied ? t("Shared.SharedComponents.copied") : t("Shared.SharedComponents.copyCode")
      }
      onClick={() => void copy(code)}
      className={cn(
        "z-10 inline-flex size-7 shrink-0 items-center justify-center rounded-md text-tertiary backdrop-blur-md transition-colors hover:bg-fill-subtle hover:text-primary focus-visible:outline-2 focus-visible:outline-offset-2",
        !title && "absolute top-2 right-2"
      )}
    >
      {copied ? (
        <Check aria-hidden="true" className="size-3.5" />
      ) : (
        <Clipboard aria-hidden="true" className="size-3.5" />
      )}
    </button>
  );

  return (
    <figure
      dir="ltr"
      tabIndex={-1}
      className={cn(
        "relative overflow-hidden rounded-xl border border-border-subtle bg-surface-raised text-sm",
        className
      )}
      {...props}
    >
      {title ? (
        <figcaption className="flex h-9 items-center gap-2 border-b border-border-subtle pr-2 pl-4 font-mono text-xs text-tertiary">
          <span className="min-w-0 flex-1 truncate">{title}</span>
          {copyButton}
        </figcaption>
      ) : (
        copyButton
      )}
      <div className={cn("overflow-auto py-3.5", viewportClassName)}>
        <pre className="m-0 w-max min-w-full bg-transparent px-4 pr-10 font-mono text-[13px] leading-6 text-primary">
          <code data-language={language}>{code}</code>
        </pre>
      </div>
    </figure>
  );
}

export function JsonCodeBlock({
  value,
  ...props
}: { value: unknown } & Omit<CodeBlockProps, "code">) {
  return <CodeBlock code={JSON.stringify(value, null, 2)} language="json" {...props} />;
}
