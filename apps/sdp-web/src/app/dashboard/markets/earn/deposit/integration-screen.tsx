"use client";

import type { EarnPortfolioAllocationInput } from "@sdp/types";
import { KeyRoundIcon } from "lucide-react";
import { useMemo } from "react";
import { Button } from "@/components/ui/button";
import { CodeBlock } from "@/components/ui/code-block";
import type { MessageKey } from "@/i18n/messages";
import { useTranslations } from "@/i18n/provider";
import { type EarnSnippet, earnApiSnippets } from "./earn-api-snippets";
import { StepNote, StepSection, SummaryRow } from "./earn-deposit-chrome";
import { OutcomeFrame } from "./earn-deposit-outcome";

/** Minimal view of an active API key — never the secret, only its prefix. */
export interface EarnApiKeyView {
  id: string;
  name: string;
  keyPrefix: string;
  environment: string;
}

const SNIPPET_TITLE_KEYS = {
  read: "DashboardEarn.deposit.integrationReadTitle",
  browse: "DashboardEarn.deposit.integrationBrowseTitle",
  switch: "DashboardEarn.deposit.integrationSwitchTitle",
  withdraw: "DashboardEarn.deposit.integrationWithdrawTitle",
} as const satisfies Record<EarnSnippet["id"], MessageKey>;

/**
 * The conditional API-integration screen, shown after confirmation when the
 * organization is an API integrator. Monospace is deliberate and permitted
 * here: this is a code surface, the one exception to the module's Inter-only
 * rule (which exists to stop addresses and IDs being monospaced).
 */
export function IntegrationScreen({
  allocations,
  apiBaseUrl,
  apiKeys,
  onDone,
  programId,
  withdrawalToken,
}: {
  allocations: EarnPortfolioAllocationInput;
  apiBaseUrl: string;
  apiKeys: readonly EarnApiKeyView[];
  /** Both footer actions land here — this screen is informational, so skipping
   *  and continuing are the same transition. */
  onDone: () => void;
  programId: string;
  withdrawalToken: string;
}) {
  const t = useTranslations();
  const snippets = useMemo(
    () => earnApiSnippets({ allocations, baseUrl: apiBaseUrl, programId, withdrawalToken }),
    [allocations, apiBaseUrl, programId, withdrawalToken]
  );

  return (
    <OutcomeFrame
      description={t("DashboardEarn.deposit.integrationDescription")}
      eyebrow={t("DashboardEarn.deposit.integrationEyebrow")}
      footer={
        // One action, because there is only one: this screen is read-only, so a
        // "Skip" beside a "Continue" that did the same thing was two names for
        // one door. The destination is the funding screen, not the dashboard,
        // so the label promises no more than "onward".
        <div className="flex justify-end">
          <Button onClick={onDone} type="button">
            {t("DashboardEarn.deposit.integrationContinue")}
          </Button>
        </div>
      }
      title={t("DashboardEarn.deposit.integrationTitle")}
    >
      <div className="space-y-5">
        <StepSection title={t("DashboardEarn.deposit.integrationKeys")}>
          <SummaryRow label={t("DashboardEarn.deposit.integrationBaseUrl")} value={apiBaseUrl} />
          {apiKeys.map((apiKey) => (
            <SummaryRow
              key={apiKey.id}
              label={apiKey.name}
              value={`${apiKey.keyPrefix}… · ${apiKey.environment}`}
            />
          ))}
        </StepSection>

        <StepNote
          body={t("DashboardEarn.deposit.integrationAuthNote")}
          icon={<KeyRoundIcon className="size-5" />}
        />

        <div className="space-y-4">
          {snippets.map((snippet) => (
            <div key={snippet.id}>
              <h3 className="mb-2 text-sm font-medium text-primary">
                {t(SNIPPET_TITLE_KEYS[snippet.id])}
              </h3>
              <CodeBlock
                code={snippet.code}
                language="javascript"
                title={snippet.request}
                viewportClassName="max-h-80"
              />
            </div>
          ))}
        </div>
      </div>
    </OutcomeFrame>
  );
}
