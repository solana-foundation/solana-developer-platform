"use client";

import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Modal } from "@/components/ui/modal";
import { useTranslations } from "@/i18n/provider";
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
  const t = useTranslations();
  const [isOpen, setIsOpen] = useState(true);
  const [copyLabel, setCopyLabel] = useState(() => t("DashboardCustody.copyValue"));

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
      setCopyLabel(t("DashboardCustody.copied"));
      window.setTimeout(() => setCopyLabel(t("DashboardCustody.copyValue")), 1200);
    } catch {
      setCopyLabel(t("DashboardCustody.unableToCopy", { label: "" }));
      window.setTimeout(() => setCopyLabel(t("DashboardCustody.copyValue")), 1600);
    }
  };

  return (
    <Modal
      isOpen={isOpen}
      onClose={close}
      ariaLabel={t("DashboardCustody.apiKeyGenerated")}
      closeLabel={t("DashboardCustody.closeGeneratedKeyModal")}
      contentClassName="p-6 text-left"
      size="md"
    >
      <p className="pr-12 text-sm font-semibold text-[#1c1c1d]">{t("DashboardCustody.apiKeyGenerated")}</p>
      <p className="mt-2 text-sm text-[rgba(28,28,29,0.72)]">{message}</p>

      {keyPrefix ? (
        <div className="mt-4 space-y-2">
          <Label htmlFor="generated-key-prefix">{t("DashboardCustody.keyPrefix")}</Label>
          <Input
            id="generated-key-prefix"
            readOnly
            value={keyPrefix}
            className="h-9 font-mono text-xs"
          />
        </div>
      ) : null}

      <div className="mt-4 space-y-2">
        <Label htmlFor="generated-key-value">{t("DashboardCustody.fullKeyShownOnce")}</Label>
        <GeneratedApiKeyInput value={keyValue} />
        <p className="text-xs text-[rgba(28,28,29,0.58)]">
          {t("DashboardCustody.apiKeyPlaygroundSession")}
        </p>
      </div>

      <div className="mt-5 flex items-center justify-end gap-2">
        <Button type="button" variant="secondary" onClick={close}>
          {t("DashboardCustody.dismiss")}
        </Button>
        <Button type="button" onClick={copy} variant="outline">
          {copyLabel}
        </Button>
      </div>
    </Modal>
  );
}

export { GeneratedApiKeyModal };
