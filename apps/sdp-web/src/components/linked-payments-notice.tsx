"use client";

import { EntityLink } from "@/components/entity-link";
import { useTranslations } from "@/i18n/provider";
import { projectHref } from "@/lib/dashboard-project-path";
import {
  linkedPaymentRequestsHref,
  linkedRecurringPaymentsHref,
  type PaymentPrincipalFilter,
} from "@/lib/payment-principal-filter";

/** What a principal set up in one project that SDP keeps running after it goes. */
export interface LinkedPaymentsProject {
  projectId: string;
  /** Shown when the projects listed span the organization; null for the current one alone. */
  projectName: string | null;
  activeRecurringPayments: number;
  openPaymentRequests: number;
}

/** A linked-payments read: still in flight, refused, or answered. */
export type LinkedPaymentsState =
  | { status: "loading" }
  | { status: "error"; message: string }
  | {
      status: "loaded";
      /** The principal, as the payment lists filter by it. */
      filter: PaymentPrincipalFilter;
      projects: LinkedPaymentsProject[];
    };

/**
 * Before a key is deleted or a member removed: what they set up that keeps running, since SDP
 * runs recurring payments and payment requests itself, with links to each list narrowed to them.
 *
 * @param props - What removing it means, and the read.
 * @param props.subject - Whether a key or a member is being removed, for the wording.
 * @param props.state - The linked-payments read.
 * @returns The notice.
 */
export function LinkedPaymentsNotice({
  subject,
  state,
}: {
  subject: "api_key" | "member";
  state: LinkedPaymentsState;
}) {
  const t = useTranslations();
  switch (state.status) {
    case "loading":
      return <p className="text-sm text-secondary">{t("Shared.linkedPayments.checking")}</p>;
    case "error":
      return (
        <p role="alert" className="text-sm text-error">
          {t("Shared.linkedPayments.loadFailed", { error: state.message })}
        </p>
      );
    case "loaded":
      break;
    default: {
      const unreachable: never = state;
      throw new Error(`Unhandled linked payments state ${String(unreachable)}`);
    }
  }
  const { filter } = state;
  const projects = state.projects.filter(
    (project) => project.activeRecurringPayments > 0 || project.openPaymentRequests > 0
  );
  if (projects.length === 0) {
    return <p className="text-sm text-secondary">{t("Shared.linkedPayments.none")}</p>;
  }
  return (
    <div className="space-y-2 rounded-card border border-warning-border bg-warning-bg p-3 text-sm">
      <p className="text-primary">
        {subject === "api_key"
          ? t("Shared.linkedPayments.keepsRunningKey")
          : t("Shared.linkedPayments.keepsRunningMember")}
      </p>
      <ul className="space-y-2">
        {projects.map((project) => (
          <li key={project.projectId} className="space-y-1">
            {project.projectName === null ? null : (
              <p className="font-medium text-primary">{project.projectName}</p>
            )}
            {project.activeRecurringPayments > 0 ? (
              <div>
                <EntityLink
                  href={projectHref(project.projectId, linkedRecurringPaymentsHref(filter))}
                  className="text-secondary"
                >
                  {t("Shared.linkedPayments.activeRecurringPayments", {
                    count: project.activeRecurringPayments,
                  })}
                </EntityLink>
              </div>
            ) : null}
            {project.openPaymentRequests > 0 ? (
              <div>
                <EntityLink
                  href={projectHref(project.projectId, linkedPaymentRequestsHref(filter))}
                  className="text-secondary"
                >
                  {t("Shared.linkedPayments.openPaymentRequests", {
                    count: project.openPaymentRequests,
                  })}
                </EntityLink>
              </div>
            ) : null}
          </li>
        ))}
      </ul>
    </div>
  );
}
