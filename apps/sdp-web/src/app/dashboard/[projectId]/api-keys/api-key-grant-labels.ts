import type { Action, ActionModule, ActionVerb } from "@sdp/types/actions";
import type { useTranslations } from "@/i18n/provider";
import { summarizeGrants } from "./api-key-authoring";

type Translate = ReturnType<typeof useTranslations>;

export function grantModuleLabel(module: ActionModule, t: Translate): string {
  return t(`DashboardCustody.apiKeyGrantModule.${module}.label`);
}

export function grantModuleDescription(module: ActionModule, t: Translate): string {
  return t(`DashboardCustody.apiKeyGrantModule.${module}.description`);
}

export function grantVerbLabel(verb: ActionVerb, t: Translate): string {
  return t(`DashboardCustody.apiKeyGrantVerb.${verb}.label`);
}

export function grantVerbDescription(verb: ActionVerb, t: Translate): string {
  return t(`DashboardCustody.apiKeyGrantVerb.${verb}.description`);
}

/** Each module's held verbs, e.g. "Transfers: Read, Execute". */
export function grantSummaryLines(grants: readonly Action[], t: Translate): string[] {
  return summarizeGrants(grants).map(
    ({ module, verbs }) =>
      `${grantModuleLabel(module, t)}: ${verbs.map((verb) => grantVerbLabel(verb, t)).join(", ")}`
  );
}

/** One line for the summary sidebar and the keys table. */
export function grantsSummaryLabel(grants: readonly Action[], t: Translate): string {
  const modules = summarizeGrants(grants).length;
  return modules === 0
    ? t("DashboardCustody.apiKeyGrantsNone")
    : t("DashboardCustody.apiKeyGrantsModuleCount", { count: modules });
}
