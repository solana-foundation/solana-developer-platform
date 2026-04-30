"use client";

import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Modal } from "@/components/ui/modal";
import { storeApiKeySecret } from "@/lib/playground-api-keys";
import { GeneratedApiKeyInput } from "./generated-key-input";

interface GeneratedApiKeyModalProps {
  keyValue: string;
  message: string;
  apiKeyId?: string;
  keyPrefix?: string;
}

function GeneratedApiKeyModal({
  keyValue,
  message,
  apiKeyId,
  keyPrefix,
}: GeneratedApiKeyModalProps) {
  const [isOpen, setIsOpen] = useState(true);
  const [copyLabel, setCopyLabel] = useState("Copy");

  useEffect(() => {
    if (!keyValue) {
      return;
    }

    storeApiKeySecret({
      value: keyValue,
      apiKeyId: apiKeyId ?? null,
      keyPrefix: keyPrefix ?? null,
    });
  }, [apiKeyId, keyValue, keyPrefix]);

  const close = async () => {
    setIsOpen(false);
  };

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
    <Modal
      isOpen={isOpen}
      onClose={close}
      ariaLabel="API key generated"
      closeLabel="Close generated key modal"
      contentClassName="p-6 text-left"
      size="md"
    >
      <p className="pr-12 text-sm font-semibold text-[#1c1c1d]">API key generated</p>
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
        <p className="text-xs text-[rgba(28,28,29,0.58)]">
          This browser session can now use this key in the API Playground without pasting it again.
        </p>
      </div>

      <div className="mt-5 flex items-center justify-end gap-2">
        <Button type="button" variant="secondary" onClick={close}>
          Dismiss
        </Button>
        <Button type="button" onClick={copy} variant="outline">
          {copyLabel}
        </Button>
      </div>
    </Modal>
  );
}

export { GeneratedApiKeyModal };
