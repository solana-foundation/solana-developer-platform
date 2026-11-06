"use client";

import { type Action, actionVerbOf, grantsCoverAction } from "@sdp/types/actions";
import { CheckIcon } from "lucide-react";
import { useTranslations } from "@/i18n/provider";
import { grantModuleRows, heldGrantsNotOffered } from "./api-key-authoring";
import { grantModuleLabel, grantVerbLabel } from "./api-key-grant-labels";

/**
 * What the key may do, module by module: a tick where it holds the verb (an included read
 * too), a dot where it does not, nothing where the module has no such verb.
 */
export function ApiKeyAccessMatrix({
  grants,
  offered,
}: {
  grants: readonly Action[];
  /** The actions this deployment's channel lets a key hold. */
  offered: readonly Action[];
}) {
  const t = useTranslations();
  const rows = grantModuleRows([...offered, ...heldGrantsNotOffered(grants, offered)]);
  const verbs = [...new Set(rows.flatMap((row) => row.actions.map(actionVerbOf)))];

  return (
    <table className="w-full table-fixed text-body">
      <thead>
        <tr className="text-meta text-secondary">
          <th scope="col" className="pb-2 text-left font-normal">
            <span className="sr-only">{t("DashboardCustody.apiKeyPage.module")}</span>
          </th>
          {verbs.map((verb) => (
            <th key={verb} scope="col" className="w-18 pb-2 text-center font-normal">
              {grantVerbLabel(verb, t)}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {rows.map(({ module, actions }) => (
          <tr key={module}>
            <th scope="row" className="truncate py-1.5 text-left font-normal text-primary">
              {grantModuleLabel(module, t)}
            </th>
            {verbs.map((verb) => {
              const action = actions.find((candidate) => actionVerbOf(candidate) === verb);
              if (!action) {
                return <td key={verb} />;
              }
              const held = grantsCoverAction(grants, action);
              return (
                <td key={verb} className="py-1.5 text-center">
                  {held ? (
                    <CheckIcon aria-hidden className="mx-auto size-4 text-primary" />
                  ) : (
                    <span
                      aria-hidden
                      className="mx-auto block size-1 rounded-full bg-border-strong"
                    />
                  )}
                  <span className="sr-only">
                    {held
                      ? t("DashboardCustody.apiKeyPage.held")
                      : t("DashboardCustody.apiKeyPage.notHeld")}
                  </span>
                </td>
              );
            })}
          </tr>
        ))}
      </tbody>
    </table>
  );
}
