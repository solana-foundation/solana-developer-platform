"use client";

import { type Action, actionVerbOf } from "@sdp/types/actions";
import { Button } from "@sdp/ui/button";
import { cn } from "@sdp/ui/cn";
import { ShieldCheck } from "lucide-react";
import { useTranslations } from "@/i18n/provider";
import {
  clearModuleGrants,
  clearOfferedGrants,
  everythingGrants,
  grantModuleRows,
  grantToggleState,
  heldGrantsNotOffered,
  toggleGrant,
} from "./api-key-authoring";
import {
  grantModuleDescription,
  grantModuleLabel,
  grantVerbDescription,
  grantVerbLabel,
} from "./api-key-grant-labels";

/**
 * Grants by module: one row per module, one checkbox per verb the module has
 * and a key may hold. Each verb is its own checkbox rather than one level
 * picker, so a module can hold `manage` and `execute` together (a recurring
 * payment's drafts and its activation are different decisions). Ticking
 * Manage or Execute shows Read as included. "None" is a row with nothing
 * ticked; "Everything" writes out every offered action. Grants the deployment
 * does not offer (a module outside its release channel) are listed read-only
 * and kept by "Everything" and "Clear all" until removed one by one.
 */
export function ApiKeyGrantPicker({
  offered,
  grants,
  touched,
  onChange,
}: {
  /** The actions this deployment's channel lets a key hold. */
  offered: readonly Action[];
  grants: readonly Action[];
  touched: boolean;
  onChange: (grants: Action[]) => void;
}) {
  const t = useTranslations();
  const rows = grantModuleRows(offered);
  const notOffered = heldGrantsNotOffered(grants, offered);

  return (
    <div>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="max-w-xl text-meta text-secondary">
          {t("DashboardCustody.apiKeyGrantsEverythingHelper")}
        </p>
        <div className="flex gap-2">
          <Button
            type="button"
            variant="secondary"
            size="sm"
            onClick={() => onChange(everythingGrants(offered, grants))}
          >
            {t("DashboardCustody.apiKeyGrantsEverything")}
          </Button>
          <Button
            type="button"
            variant="secondary"
            size="sm"
            onClick={() => onChange(clearOfferedGrants(grants, offered))}
          >
            {t("DashboardCustody.apiKeyGrantsClear")}
          </Button>
        </div>
      </div>
      <div className="mt-3 overflow-hidden rounded-card border border-border-default bg-surface-tile">
        {rows.map(({ module, actions }) => {
          const label = grantModuleLabel(module, t);
          const held = actions.some((action) => grantToggleState(grants, action) !== "off");
          return (
            <fieldset
              key={module}
              className="flex flex-col gap-3 border-b border-border-subtle px-4 py-3 last:border-b-0 sm:flex-row sm:items-center"
            >
              <legend className="sr-only">{label}</legend>
              <div className="min-w-0 flex-1">
                <p className="text-field text-primary">{label}</p>
                <p className="mt-0.5 text-meta text-secondary">
                  {grantModuleDescription(module, t, offered)}
                </p>
              </div>
              <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
                {actions.map((action) => {
                  const verb = actionVerbOf(action);
                  const state = grantToggleState(grants, action);
                  return (
                    <label
                      key={action}
                      title={
                        state === "implied"
                          ? t("DashboardCustody.apiKeyGrantsImpliedHelper")
                          : grantVerbDescription(verb, t)
                      }
                      className={cn(
                        "flex items-center gap-2 text-body",
                        state === "implied" ? "text-tertiary" : "text-primary"
                      )}
                    >
                      <input
                        type="checkbox"
                        checked={state !== "off"}
                        disabled={state === "implied"}
                        onChange={() => onChange(toggleGrant(grants, action))}
                        aria-label={t("DashboardCustody.apiKeyGrantsToggle", {
                          verb: grantVerbLabel(verb, t),
                          module: label,
                        })}
                      />
                      {grantVerbLabel(verb, t)}
                      {state === "implied" ? (
                        <span className="text-meta text-tertiary">
                          ({t("DashboardCustody.apiKeyGrantsImplied")})
                        </span>
                      ) : null}
                    </label>
                  );
                })}
                <button
                  type="button"
                  className={cn("text-meta text-secondary underline", held ? "" : "invisible")}
                  onClick={() => onChange(clearModuleGrants(grants, module))}
                  aria-hidden={!held}
                  tabIndex={held ? 0 : -1}
                >
                  {t("DashboardCustody.none")}
                </button>
              </div>
            </fieldset>
          );
        })}
      </div>
      {notOffered.length > 0 ? (
        <div className="mt-3 rounded-card border border-border-default px-4 py-3">
          <p className="text-meta text-secondary">{t("DashboardCustody.apiKeyGrantsNotOffered")}</p>
          <ul className="mt-2 flex flex-wrap gap-2">
            {notOffered.map((action) => (
              <li
                key={action}
                className="flex items-center gap-2 rounded-md bg-fill-subtle px-2 py-1 font-mono text-meta text-primary"
              >
                {action}
                <button
                  type="button"
                  className="text-secondary underline"
                  onClick={() => onChange(grants.filter((grant) => grant !== action))}
                  aria-label={t("DashboardCustody.apiKeyGrantsRemove", { action })}
                >
                  ×
                </button>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      {touched && grants.length === 0 ? (
        <p className="mt-2 text-meta text-error">{t("DashboardCustody.apiKeyGrantsRequired")}</p>
      ) : null}
      <p className="mt-2 flex items-center gap-1.5 text-meta text-tertiary">
        <ShieldCheck aria-hidden className="size-3.5 shrink-0" />
        {t("DashboardCustody.apiKeyGrantsNotGrantable")}
      </p>
    </div>
  );
}
