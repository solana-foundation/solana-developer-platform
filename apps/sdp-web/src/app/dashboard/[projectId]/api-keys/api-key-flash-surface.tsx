"use client";

import { useEffect, useState } from "react";
import { Card, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { useTranslations } from "@/i18n/provider";
import { useProjectHref } from "@/lib/use-dashboard-project";
import { API_KEYS_FLASH_PATH, type ApiKeyFlash } from "./api-key-flash";
import { GeneratedApiKeyModal } from "./generated-key-modal";

interface ApiKeyFlashResponse {
  flash: ApiKeyFlash | null;
}

const pendingFlashRequests = new Map<string, Promise<ApiKeyFlash | null>>();

async function loadApiKeyFlash(flashPath: string): Promise<ApiKeyFlash | null> {
  const pending = pendingFlashRequests.get(flashPath);
  if (pending !== undefined) {
    return pending;
  }
  // POST, not GET: reading the flash consumes the one-time cookie, and a
  // GET with that side effect is exposed to prefetching and CSRF.
  const request = fetch(flashPath, {
    method: "POST",
    cache: "no-store",
    credentials: "same-origin",
  })
    .then(async (response) => {
      if (!response.ok) {
        // 401 (logged out) and unexpected errors alike mean "no flash";
        // the route already destroyed any pending cookie on its side.
        return null;
      }
      const payload = (await response.json()) as ApiKeyFlashResponse;
      return payload.flash;
    })
    .catch(() => null)
    .finally(() => {
      pendingFlashRequests.delete(flashPath);
    });
  pendingFlashRequests.set(flashPath, request);
  return request;
}

export function ApiKeyFlashSurface() {
  const t = useTranslations();
  const flashPath = useProjectHref()(API_KEYS_FLASH_PATH);
  const [flash, setFlash] = useState<ApiKeyFlash | null>(null);
  const [isLoaded, setIsLoaded] = useState(false);

  useEffect(() => {
    let isActive = true;

    const loadFlash = async () => {
      const nextFlash = await loadApiKeyFlash(flashPath);

      if (isActive) {
        setFlash(nextFlash);
        setIsLoaded(true);
      }
    };

    void loadFlash();

    return () => {
      isActive = false;
    };
  }, [flashPath]);

  if (!isLoaded || !flash) {
    return null;
  }

  if (flash.key) {
    return (
      <GeneratedApiKeyModal
        keyValue={flash.key}
        message={flash.message}
        apiKeyId={flash.apiKeyId}
        keyPrefix={flash.keyPrefix}
      />
    );
  }

  return (
    <Card className={flash.level === "error" ? "ring-destructive/25" : "ring-primary/12"}>
      <CardHeader>
        <CardTitle>
          {flash.level === "error"
            ? t("DashboardCustody.actionFailed")
            : t("DashboardCustody.notice")}
        </CardTitle>
        <CardDescription>{flash.message}</CardDescription>
      </CardHeader>
    </Card>
  );
}
