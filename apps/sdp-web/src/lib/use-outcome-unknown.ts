"use client";

import { useRouter } from "next/navigation";
import { useCallback } from "react";
import { toast } from "sonner";
import { useSWRConfig } from "swr";
import { useTranslations } from "@/i18n/provider";
import { type ApiAnswer, isOutcomeUnknownAnswer } from "./idempotency";

/**
 * Refreshes what the page shows after a 409 `IDEMPOTENCY_KEY_OUTCOME_UNKNOWN`
 * (HOO-1918): every SWR list in this dashboard scope and the server-rendered
 * page, so a row the earlier attempt may have created shows up.
 */
export function useOutcomeUnknownRefresh(): () => void {
  const router = useRouter();
  const { mutate } = useSWRConfig();
  return useCallback(() => {
    void mutate(() => true);
    router.refresh();
  }, [mutate, router]);
}

/**
 * The one handling of a 409 `IDEMPOTENCY_KEY_OUTCOME_UNKNOWN` for a create
 * form (HOO-1918). The earlier request may have run, so the form must not
 * offer a plain retry: the key is already retired (`answerRetiresKey`), and
 * this tells the user to check the list, and refreshes it. Nothing is resent.
 *
 * @returns `notice(answer)`: whether the answer was that 409 and was handled,
 *   so the form shows nothing else for it.
 */
export function useOutcomeUnknownNotice(): (answer: ApiAnswer) => boolean {
  const t = useTranslations();
  const refresh = useOutcomeUnknownRefresh();
  return useCallback(
    (answer) => {
      if (!isOutcomeUnknownAnswer(answer)) return false;
      toast.error(t("Shared.idempotency.outcomeUnknownCheckList"));
      refresh();
      return true;
    },
    [refresh, t]
  );
}
