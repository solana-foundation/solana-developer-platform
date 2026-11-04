import {
  ACTION_MODULES,
  type Action,
  type ActionModule,
  type ActionVerb,
  actionModuleOf,
} from "@sdp/types/actions";
import type { useTranslations } from "@/i18n/provider";
import { summarizeGrants } from "./api-key-authoring";

type Translate = ReturnType<typeof useTranslations>;

export function grantModuleLabel(module: ActionModule, t: Translate): string {
  return t(`DashboardCustody.apiKeyGrantModule.${module}.label`);
}

/**
 * A module's line in the grant picker. Counterparties' Execute also submits ramp provider
 * requirements, a Ramps route, so its line names them only where the deployment offers Ramps.
 *
 * @param module - The grant module.
 * @param t - Translator.
 * @param offered - The actions this deployment's channel lets a key hold.
 * @returns The module's description.
 */
export function grantModuleDescription(
  module: ActionModule,
  t: Translate,
  offered: readonly Action[]
): string {
  if (module === "counterparties" && !offersRamps(offered)) {
    return t("DashboardCustody.apiKeyGrantModule.counterparties.descriptionWithoutRamps");
  }
  return t(`DashboardCustody.apiKeyGrantModule.${module}.description`);
}

function offersRamps(offered: readonly Action[]): boolean {
  return offered.some((action) => ACTION_MODULES[actionModuleOf(action)].owner === "ramps");
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
