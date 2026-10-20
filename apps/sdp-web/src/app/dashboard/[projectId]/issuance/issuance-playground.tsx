"use client";

import { useMemo } from "react";
import { ApiPlaygroundShell } from "@/components/api-playground-shell";
import { useTranslations } from "@/i18n/provider";
import {
  buildIssuancePlaygroundEndpointConfigs,
  type IssuancePlaygroundTemplateView,
  type IssuancePlaygroundTokenView,
} from "./issuance-playground-config";

interface IssuancePlaygroundProps {
  apiBaseUrl?: string | null;
  templates: IssuancePlaygroundTemplateView[];
  templatesError: string | null;
  tokens: IssuancePlaygroundTokenView[];
}

export function IssuancePlayground({
  apiBaseUrl,
  templates,
  templatesError,
  tokens,
}: IssuancePlaygroundProps) {
  const t = useTranslations();
  const endpoints = useMemo(
    () => buildIssuancePlaygroundEndpointConfigs({ templates, tokens, t }),
    [templates, tokens, t]
  );

  return (
    <ApiPlaygroundShell
      productName={t("DashboardIssuance.playground.productName")}
      endpoints={endpoints}
      defaultEndpointId="mint-execute"
      apiBaseUrl={apiBaseUrl}
      leftMessages={templatesError ? [{ text: templatesError, tone: "critical" }] : []}
    />
  );
}
