"use client";

import { useEffect, useState } from "react";
import { Card, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { API_KEYS_FLASH_PATH, type ApiKeyFlash } from "./api-key-flash";
import { GeneratedApiKeyModal } from "./generated-key-modal";

interface ApiKeyFlashResponse {
  flash: ApiKeyFlash | null;
}

let pendingFlashRequest: Promise<ApiKeyFlash | null> | null = null;

async function loadApiKeyFlash(): Promise<ApiKeyFlash | null> {
  if (!pendingFlashRequest) {
    pendingFlashRequest = fetch(API_KEYS_FLASH_PATH, {
      method: "GET",
      cache: "no-store",
      credentials: "same-origin",
    })
      .then(async (response) => {
        const payload = (await response.json()) as ApiKeyFlashResponse;
        return payload.flash;
      })
      .catch(() => null)
      .finally(() => {
        pendingFlashRequest = null;
      });
  }

  return pendingFlashRequest;
}

export function ApiKeyFlashSurface() {
  const [flash, setFlash] = useState<ApiKeyFlash | null>(null);
  const [isLoaded, setIsLoaded] = useState(false);

  useEffect(() => {
    let isActive = true;

    const loadFlash = async () => {
      const nextFlash = await loadApiKeyFlash();

      if (isActive) {
        setFlash(nextFlash);
        setIsLoaded(true);
      }
    };

    void loadFlash();

    return () => {
      isActive = false;
    };
  }, []);

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
    <Card className={flash.level === "error" ? "border-[#c71f37]/25" : "border-[#1c1c1d]/12"}>
      <CardHeader>
        <CardTitle>{flash.level === "error" ? "Action failed" : "Notice"}</CardTitle>
        <CardDescription>{flash.message}</CardDescription>
      </CardHeader>
    </Card>
  );
}
