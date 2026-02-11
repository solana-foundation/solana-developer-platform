"use client";

import { OrganizationSwitcher, UserButton } from "@clerk/nextjs";
import Link from "next/link";

export function DashboardHeader({
  title,
  subtitle = "Dashboard",
  backHref,
}: {
  title: string;
  subtitle?: string;
  backHref?: string;
}) {
  return (
    <header className="flex flex-wrap items-center justify-between gap-4">
      <div className="space-y-1">
        <div className="flex items-center gap-3">
          {backHref ? (
            <Link
              href={backHref}
              className="text-xs uppercase tracking-wide text-muted-foreground hover:text-foreground"
            >
              Back
            </Link>
          ) : null}
          <p className="text-xs uppercase tracking-wide text-muted-foreground">{subtitle}</p>
        </div>
        <h1 className="text-2xl font-semibold text-foreground">{title}</h1>
      </div>

      <div className="flex items-center gap-3">
        <OrganizationSwitcher hidePersonal />
        <UserButton />
      </div>
    </header>
  );
}
