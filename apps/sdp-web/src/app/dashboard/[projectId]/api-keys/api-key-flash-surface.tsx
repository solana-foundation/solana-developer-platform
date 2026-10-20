"use client";

import { useAuth } from "@clerk/nextjs";
import { Card, CardDescription, CardHeader, CardTitle } from "@sdp/ui/card";
import { useEffect, useState } from "react";
import { useTranslations } from "@/i18n/provider";
import { useProjectHref } from "@/lib/use-dashboard-project";
import { API_KEYS_FLASH_PATH, type ApiKeyFlash } from "./api-key-flash";
import { GeneratedApiKeyModal } from "./generated-key-modal";

interface ApiKeyFlashResponse {
  flash: ApiKeyFlash | null;
}

/**
 * In-flight flash reads, keyed by the auth scope that started them (Clerk session,
 * user, organization) and the Project's flash path. Reading consumes the one-time
 * cookie, so two surfaces of ONE scope (Strict Mode's double mount, a duplicated
 * surface) must share the read; a surface of any other scope never may, or the
 * next account in this tab would be handed the previous account's new key
 * (APE-547). An entry lives only while its request is in flight.
 */
const pendingFlashRequests = new Map<string, Promise<ApiKeyFlash | null>>();

function loadApiKeyFlash(scopeKey: string, flashPath: string): Promise<ApiKeyFlash | null> {
  const pending = pendingFlashRequests.get(scopeKey);
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
      pendingFlashRequests.delete(scopeKey);
    });
  pendingFlashRequests.set(scopeKey, request);
  return request;
}

/** The auth scope a flash belongs to, or null until Clerk has a signed-in session. */
function useFlashScopeKey(flashPath: string): string | null {
  const { isLoaded, sessionId, userId, orgId } = useAuth();
  if (!isLoaded || !sessionId || !userId) {
    return null;
  }
  return JSON.stringify([sessionId, userId, orgId ?? null, flashPath]);
}

export function ApiKeyFlashSurface() {
  const t = useTranslations();
  const flashPath = useProjectHref()(API_KEYS_FLASH_PATH);
  const scopeKey = useFlashScopeKey(flashPath);
  // The flash is held with the scope that read it, and shown only while that scope is
  // current: a sign-out, account or organization switch, or Project change drops it at once.
  const [loaded, setLoaded] = useState<{ scopeKey: string; flash: ApiKeyFlash | null } | null>(
    null
  );

  useEffect(() => {
    if (scopeKey === null) {
      return;
    }
    let isActive = true;

    void loadApiKeyFlash(scopeKey, flashPath).then((flash) => {
      if (isActive) {
        setLoaded({ scopeKey, flash });
      }
    });

    return () => {
      isActive = false;
    };
  }, [flashPath, scopeKey]);

  const flash = loaded !== null && loaded.scopeKey === scopeKey ? loaded.flash : null;
  if (!flash) {
    return null;
  }

  if (flash.key) {
    return (
      <GeneratedApiKeyModal
        key={scopeKey}
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
