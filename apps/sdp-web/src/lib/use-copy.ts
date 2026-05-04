"use client";

import { useCallback, useState } from "react";

export interface UseCopyReturn {
  copied: boolean;
  value?: string;
  copy: (value: string) => Promise<void>;
}

export function useCopy(delay = 1000): UseCopyReturn {
  const [value, setValue] = useState<string | undefined>();
  const [copied, setCopied] = useState(false);

  const copyToClipboard = useCallback(
    async (text: string) => {
      await navigator.clipboard.writeText(text);
      setValue(text);
      setCopied(true);
      window.setTimeout(() => setCopied(false), delay);
    },
    [delay]
  );

  return { value, copied, copy: copyToClipboard };
}
