"use client";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { storeApiKeySecret } from "@/lib/playground-api-keys";
import { useEscapeKey } from "@/lib/use-escape-key";
import { useEffect, useState } from "react";
import { clearApiKeyFlashAction } from "./actions";
import { GeneratedApiKeyInput } from "./generated-key-input";

interface GeneratedApiKeyModalProps {
  keyValue: string;
  message: string;
  keyPrefix?: string;
}

function GeneratedApiKeyModal({ keyValue, message, keyPrefix }: GeneratedApiKeyModalProps) {
  const [isOpen, setIsOpen] = useState(true);
  const [copyLabel, setCopyLabel] = useState("Copy");

  useEffect(() => {
    if (!keyValue) {
      return;
    }

    storeApiKeySecret({
      value: keyValue,
      keyPrefix: keyPrefix ?? null,
    });
  }, [keyValue, keyPrefix]);

  const close = async () => {
    setIsOpen(false);
    await clearApiKeyFlashAction();
  };

  useEscapeKey(isOpen, () => {
    void close();
  });

  if (!isOpen) {
    return null;
  }

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(keyValue);
      setCopyLabel("Copied");
      window.setTimeout(() => setCopyLabel("Copy"), 1200);
    } catch {
      setCopyLabel("Unable to copy");
      window.setTimeout(() => setCopyLabel("Copy"), 1600);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center px-4 py-8">
      <button
        type="button"
        aria-label="Close generated key modal overlay"
        className="absolute inset-0 bg-black/35"
        onClick={close}
      />
      <div className="relative z-10 w-full max-w-lg rounded-2xl border border-[rgba(28,28,29,0.16)] bg-white p-6 shadow-lg">
        <p className="text-sm font-semibold text-[#1c1c1d]">API key generated</p>
        <p className="mt-2 text-sm text-[rgba(28,28,29,0.72)]">{message}</p>

        {keyPrefix ? (
          <div className="mt-4 space-y-2">
            <Label htmlFor="generated-key-prefix">Key prefix</Label>
            <Input
              id="generated-key-prefix"
              readOnly
              value={keyPrefix}
              className="h-9 font-mono text-xs"
            />
          </div>
        ) : null}

        <div className="mt-4 space-y-2">
          <Label htmlFor="generated-key-value">Your full key (shown once)</Label>
          <GeneratedApiKeyInput value={keyValue} />
        </div>

        <div className="mt-5 flex items-center justify-end gap-2">
          <Button type="button" variant="secondary" onClick={close}>
            Dismiss
          </Button>
          <Button type="button" onClick={copy} variant="outline">
            {copyLabel}
          </Button>
        </div>
      </div>
    </div>
  );
}

export { GeneratedApiKeyModal };
