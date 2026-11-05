"use client";

import { useReverification, useSession, useUser } from "@clerk/nextjs";
import type { SessionWithActivitiesResource, UserResource } from "@clerk/nextjs/types";
import { Badge } from "@sdp/ui/badge";
import { Button } from "@sdp/ui/button";
import { Input } from "@sdp/ui/input";
import { Label } from "@sdp/ui/label";
import { SkeletonBlock } from "@sdp/ui/skeleton-block";
import { type FormEvent, useId, useState, useTransition } from "react";
import { toast } from "sonner";
import useSWR, { useSWRConfig } from "swr";
import { z } from "zod";
import { accountQueryKeys } from "@/app/(session)/dashboard/[projectId]/account/account-query-key";
import { formatDateTime } from "@/app/(session)/dashboard/[projectId]/payments/payments-presentation";
import { RecordSection } from "@/app/(session)/dashboard/[projectId]/payments/payments-record";
import { useLocale, useTranslations } from "@/i18n/provider";
import { useZodForm } from "@/lib/use-zod-form";
import { useReportAccountError } from "./account-errors";
import { isLiveSession } from "./account-sessions";

const PASSWORD_SCHEMA = z.object({
  currentPassword: z.string(),
  newPassword: z.string().min(1),
});

export function AccountSecurity() {
  const { user } = useUser();
  if (!user) {
    return null;
  }
  return (
    <div className="flex w-full flex-col gap-2.5">
      <PasswordSection user={user} />
      <SessionsSection user={user} />
    </div>
  );
}

function PasswordSection({ user }: { user: UserResource }) {
  const t = useTranslations();
  const [isEditing, setEditing] = useState(false);

  return (
    <RecordSection
      title={t("Shared.account.security.passwordTitle")}
      aside={
        isEditing ? null : (
          <Button type="button" variant="outline" size="sm" onClick={() => setEditing(true)}>
            {user.passwordEnabled
              ? t("Shared.account.security.changePassword")
              : t("Shared.account.security.setPassword")}
          </Button>
        )
      }
    >
      {isEditing ? (
        <PasswordForm user={user} close={() => setEditing(false)} />
      ) : (
        <p className="text-meta text-secondary">
          {user.passwordEnabled
            ? t("Shared.account.security.passwordSet")
            : t("Shared.account.security.passwordNotSet")}
        </p>
      )}
    </RecordSection>
  );
}

function PasswordForm({ user, close }: { user: UserResource; close: () => void }) {
  const t = useTranslations();
  const currentPasswordId = useId();
  const newPasswordId = useId();
  const form = useZodForm(PASSWORD_SCHEMA, { currentPassword: "", newPassword: "" });
  const reportError = useReportAccountError();
  const { mutate } = useSWRConfig();
  const [isPending, startTransition] = useTransition();
  const updatePassword = useReverification(
    (params: Parameters<UserResource["updatePassword"]>[0]) => user.updatePassword(params)
  );

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const parsed = form.validate();
    if (!parsed.ok) {
      return;
    }
    startTransition(async () => {
      try {
        await updatePassword({
          newPassword: parsed.data.newPassword,
          currentPassword: user.passwordEnabled ? parsed.data.currentPassword : undefined,
          signOutOfOtherSessions: true,
        });
        toast.success(t("Shared.account.security.passwordSaved"));
        close();
        void mutate(accountQueryKeys.sessions({ userId: user.id }));
      } catch (error) {
        reportError(error);
      }
    });
  };

  return (
    <form onSubmit={submit} className="flex max-w-md flex-col gap-4">
      {user.passwordEnabled ? (
        <div className="flex flex-col gap-1.5">
          <Label htmlFor={currentPasswordId}>{t("Shared.account.security.currentPassword")}</Label>
          <Input
            id={currentPasswordId}
            type="password"
            required
            autoComplete="current-password"
            value={form.values.currentPassword}
            onChange={(event) => form.setField("currentPassword", event.target.value)}
          />
        </div>
      ) : null}
      <div className="flex flex-col gap-1.5">
        <Label htmlFor={newPasswordId}>{t("Shared.account.security.newPassword")}</Label>
        <Input
          id={newPasswordId}
          type="password"
          required
          autoComplete="new-password"
          value={form.values.newPassword}
          onChange={(event) => form.setField("newPassword", event.target.value)}
        />
        <p className="text-meta text-secondary">{t("Shared.account.security.newPasswordHint")}</p>
      </div>
      <div className="flex gap-2">
        <Button type="submit" size="sm" loading={isPending}>
          {t("Shared.account.save")}
        </Button>
        <Button type="button" variant="ghost" size="sm" disabled={isPending} onClick={close}>
          {t("Shared.account.cancel")}
        </Button>
      </div>
    </form>
  );
}

function SessionsSection({ user }: { user: UserResource }) {
  const t = useTranslations();
  const { session: currentSession } = useSession();
  const sessions = useSWR(accountQueryKeys.sessions({ userId: user.id }), () => user.getSessions());
  const activeSessions = (sessions.data ?? [])
    .filter(isLiveSession)
    .toSorted(
      (left, right) =>
        Number(right.id === currentSession?.id) - Number(left.id === currentSession?.id)
    );

  return (
    <RecordSection title={t("Shared.account.security.sessionsTitle")}>
      <p className="text-meta text-secondary">{t("Shared.account.security.sessionsDescription")}</p>
      {sessions.error ? (
        <div className="flex flex-wrap items-center gap-3">
          <p className="text-body text-secondary">{t("Shared.account.security.sessionsFailed")}</p>
          <Button type="button" variant="outline" size="sm" onClick={() => void sessions.mutate()}>
            {t("Shared.account.retry")}
          </Button>
        </div>
      ) : sessions.data === undefined ? (
        <div className="flex flex-col gap-3" aria-busy="true">
          <SkeletonBlock className="h-10 w-full" />
          <SkeletonBlock className="h-10 w-full" />
        </div>
      ) : (
        <ul className="flex flex-col">
          {activeSessions.map((session) => (
            <SessionRow
              key={session.id}
              session={session}
              isCurrent={session.id === currentSession?.id}
              onRevoked={() => void sessions.mutate()}
            />
          ))}
        </ul>
      )}
    </RecordSection>
  );
}

function SessionRow({
  session,
  isCurrent,
  onRevoked,
}: {
  session: SessionWithActivitiesResource;
  isCurrent: boolean;
  onRevoked: () => void;
}) {
  const t = useTranslations();
  const locale = useLocale();
  const reportError = useReportAccountError();
  const [isPending, startTransition] = useTransition();
  const revoke = useReverification(() => session.revoke());
  const { browserName, browserVersion, deviceType, city, country, ipAddress } =
    session.latestActivity;
  const device = [
    browserName && [browserName, browserVersion].filter(Boolean).join(" "),
    deviceType,
  ]
    .filter(Boolean)
    .join(" · ");
  const place = [[city, country].filter(Boolean).join(", "), ipAddress].filter(Boolean).join(" · ");
  const lastActive = formatDateTime(session.lastActiveAt.toISOString(), locale);

  const signOut = () => {
    startTransition(async () => {
      try {
        await revoke();
        onRevoked();
      } catch (error) {
        reportError(error);
      }
    });
  };

  return (
    <li className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-border-subtle py-2.5 last:border-b-0">
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="flex items-center gap-2">
          <span className="truncate text-body text-primary">
            {device || t("Shared.account.security.unknownDevice")}
          </span>
          {isCurrent ? (
            <Badge variant="info">{t("Shared.account.security.thisDevice")}</Badge>
          ) : null}
        </span>
        <span className="truncate text-meta text-secondary">
          {[
            place,
            lastActive === null
              ? null
              : t("Shared.account.security.lastActive", { time: lastActive }),
          ]
            .filter(Boolean)
            .join(" · ")}
        </span>
      </span>
      {isCurrent ? null : (
        <Button type="button" variant="outline" size="sm" loading={isPending} onClick={signOut}>
          {t("Shared.account.security.signOutSession")}
        </Button>
      )}
    </li>
  );
}
