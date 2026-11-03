"use client";

import { Button } from "@sdp/ui/button";
import { ListEmptyState } from "@sdp/ui/list-empty-state";
import Link from "next/link";
import { DashboardPageTitle } from "@/components/dashboard-page-title";
import { useTranslations } from "@/i18n/provider";
import { useProjectHref } from "@/lib/use-dashboard-project";

/**
 * A missing page inside a Project, from `notFound()` or an address no route matches: the shell
 * stays, its title says so, and the way back is the Project's Overview. The root 404 is for
 * addresses outside any Project.
 *
 * @returns The Project's not-found view.
 */
export default function ProjectNotFound() {
  const t = useTranslations();
  const href = useProjectHref();
  return (
    <>
      <DashboardPageTitle title={t("NotFound.title")} />
      <ListEmptyState
        message={t("NotFound.description")}
        action={
          <Button asChild>
            <Link href={href("/dashboard")}>{t("NotFound.backToOverview")}</Link>
          </Button>
        }
      />
    </>
  );
}
