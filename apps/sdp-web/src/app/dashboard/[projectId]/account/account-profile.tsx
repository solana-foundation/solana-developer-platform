"use client";

import { useOrganization, useReverification, useUser } from "@clerk/nextjs";
import type { EmailAddressResource, UserResource } from "@clerk/nextjs/types";
import type { OrganizationRole } from "@sdp/types/roles";
import { Badge } from "@sdp/ui/badge";
import { Button } from "@sdp/ui/button";
import { Input } from "@sdp/ui/input";
import { Label } from "@sdp/ui/label";
import { type ChangeEvent, type FormEvent, useId, useRef, useState, useTransition } from "react";
import { toast } from "sonner";
import {
  RecordList,
  RecordRow,
  RecordSection,
} from "@/app/dashboard/[projectId]/payments/payments-record";
import { UserAvatar, userDisplayName } from "@/components/user-avatar";
import { useDashboardWorkspace } from "@/contexts/dashboard-workspace-context";
import type { MessageKey } from "@/i18n/messages";
import { useTranslations } from "@/i18n/provider";
import { useReportAccountError } from "./account-errors";

// Clerk's own uploader accepts these and nothing over 10 MB; the API does not say why it refuses.
const PROFILE_IMAGE_TYPES = ["image/png", "image/jpeg", "image/gif", "image/webp"] as const;
const PROFILE_IMAGE_MAX_BYTES = 10_000_000;

const ROLE_LABEL_KEYS = {
  admin: "Shared.members.roleAdmin",
  member: "Shared.members.roleMember",
  viewer: "Shared.members.roleViewer",
} as const satisfies Record<OrganizationRole, MessageKey>;

export function AccountProfile() {
  const { user } = useUser();
  if (!user) {
    return null;
  }
  return (
    <div className="flex w-full flex-col gap-2.5">
      <ProfilePhotoSection user={user} />
      <ProfileDetailsSection user={user} />
      <EmailAddressesSection user={user} />
    </div>
  );
}

function ProfilePhotoSection({ user }: { user: UserResource }) {
  const t = useTranslations();
  const reportError = useReportAccountError();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [isPending, startTransition] = useTransition();

  const saveImage = (file: File | null) => {
    startTransition(async () => {
      try {
        await user.setProfileImage({ file });
      } catch (error) {
        reportError(error);
      }
    });
  };

  const pickFile = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) {
      return;
    }
    if (!PROFILE_IMAGE_TYPES.some((type) => type === file.type)) {
      toast.error(t("Shared.account.profile.photoWrongType"));
      return;
    }
    if (file.size > PROFILE_IMAGE_MAX_BYTES) {
      toast.error(t("Shared.account.profile.photoTooLarge"));
      return;
    }
    saveImage(file);
  };

  return (
    <RecordSection title={t("Shared.account.profile.photoTitle")}>
      <div className="flex flex-wrap items-center gap-5">
        <UserAvatar
          name={userDisplayName(user)}
          imageUrl={user.hasImage ? user.imageUrl : ""}
          className="size-16 text-body refresh:size-16 refresh:text-body"
        />
        <input
          ref={fileInputRef}
          type="file"
          accept={PROFILE_IMAGE_TYPES.join(",")}
          className="sr-only"
          tabIndex={-1}
          aria-hidden="true"
          onChange={pickFile}
        />
        <div className="flex flex-col gap-2">
          <p className="text-meta text-secondary">{t("Shared.account.profile.photoDescription")}</p>
          <div className="flex flex-wrap gap-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              loading={isPending}
              onClick={() => fileInputRef.current?.click()}
            >
              {t("Shared.account.profile.photoUpload")}
            </Button>
            {user.hasImage ? (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                disabled={isPending}
                onClick={() => saveImage(null)}
              >
                {t("Shared.account.profile.photoRemove")}
              </Button>
            ) : null}
          </div>
        </div>
      </div>
    </RecordSection>
  );
}

function ProfileDetailsSection({ user }: { user: UserResource }) {
  const t = useTranslations();
  const { organization } = useOrganization();
  const { dashboardAccess } = useDashboardWorkspace();
  const [isEditing, setEditing] = useState(false);

  return (
    <RecordSection
      title={t("Shared.account.profile.detailsTitle")}
      aside={
        isEditing ? null : (
          <Button type="button" variant="outline" size="sm" onClick={() => setEditing(true)}>
            {t("Shared.account.edit")}
          </Button>
        )
      }
    >
      {isEditing ? (
        <ProfileNameForm user={user} close={() => setEditing(false)} />
      ) : (
        <RecordList>
          <RecordRow label={t("Shared.account.profile.name")}>
            {user.fullName || t("Shared.account.profile.noName")}
          </RecordRow>
          <RecordRow label={t("Shared.account.profile.userId")} copy={user.id}>
            <span className="tabular-nums">{user.id}</span>
          </RecordRow>
          {organization ? (
            <RecordRow label={t("Shared.account.profile.organization")}>
              {t("Shared.account.profile.organizationRole", {
                organization: organization.name,
                role: t(ROLE_LABEL_KEYS[dashboardAccess.role]),
              })}
            </RecordRow>
          ) : null}
        </RecordList>
      )}
    </RecordSection>
  );
}

function ProfileNameForm({ user, close }: { user: UserResource; close: () => void }) {
  const t = useTranslations();
  const reportError = useReportAccountError();
  const firstNameId = useId();
  const lastNameId = useId();
  const [firstName, setFirstName] = useState(user.firstName ?? "");
  const [lastName, setLastName] = useState(user.lastName ?? "");
  const [isPending, startTransition] = useTransition();

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    startTransition(async () => {
      try {
        await user.update({ firstName: firstName.trim(), lastName: lastName.trim() });
        toast.success(t("Shared.account.profile.nameSaved"));
        close();
      } catch (error) {
        reportError(error);
      }
    });
  };

  return (
    <form onSubmit={submit} className="flex max-w-md flex-col gap-4">
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor={firstNameId}>{t("Shared.account.profile.firstName")}</Label>
          <Input
            id={firstNameId}
            value={firstName}
            autoComplete="given-name"
            onChange={(event) => setFirstName(event.target.value)}
          />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor={lastNameId}>{t("Shared.account.profile.lastName")}</Label>
          <Input
            id={lastNameId}
            value={lastName}
            autoComplete="family-name"
            onChange={(event) => setLastName(event.target.value)}
          />
        </div>
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

function EmailAddressesSection({ user }: { user: UserResource }) {
  const t = useTranslations();
  const [verifying, setVerifying] = useState<EmailAddressResource | null>(null);
  const [isAdding, setAdding] = useState(false);

  return (
    <RecordSection
      title={t("Shared.account.emails.title")}
      aside={
        isAdding || verifying ? null : (
          <Button type="button" variant="outline" size="sm" onClick={() => setAdding(true)}>
            {t("Shared.account.emails.add")}
          </Button>
        )
      }
    >
      <p className="text-meta text-secondary">{t("Shared.account.emails.description")}</p>
      <ul className="flex flex-col">
        {user.emailAddresses.map((emailAddress) => (
          <EmailAddressRow
            key={emailAddress.id}
            user={user}
            emailAddress={emailAddress}
            onVerify={() => {
              setAdding(false);
              setVerifying(emailAddress);
            }}
          />
        ))}
      </ul>
      {isAdding ? (
        <AddEmailForm
          user={user}
          onCreated={(emailAddress) => {
            setAdding(false);
            setVerifying(emailAddress);
          }}
          onCancel={() => setAdding(false)}
        />
      ) : null}
      {verifying ? (
        <VerifyEmailForm
          key={verifying.id}
          emailAddress={verifying}
          close={() => setVerifying(null)}
        />
      ) : null}
    </RecordSection>
  );
}

function EmailAddressRow({
  user,
  emailAddress,
  onVerify,
}: {
  user: UserResource;
  emailAddress: EmailAddressResource;
  onVerify: () => void;
}) {
  const t = useTranslations();
  const reportError = useReportAccountError();
  const [isPending, startTransition] = useTransition();
  const isPrimary = emailAddress.id === user.primaryEmailAddressId;
  const isVerified = emailAddress.verification.status === "verified";
  const makePrimary = useReverification(async () => {
    await user.update({ primaryEmailAddressId: emailAddress.id });
  });
  const remove = useReverification(() => emailAddress.destroy());

  const run = (action: () => Promise<void>) => {
    startTransition(async () => {
      try {
        await action();
      } catch (error) {
        reportError(error);
      }
    });
  };
  const sendCode = async () => {
    await emailAddress.prepareVerification({ strategy: "email_code" });
    onVerify();
  };

  return (
    <li className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-border-subtle py-2.5 last:border-b-0">
      <span className="min-w-0 flex-1 truncate text-body text-primary">
        {emailAddress.emailAddress}
      </span>
      <span className="flex shrink-0 items-center gap-1.5">
        {isPrimary ? <Badge variant="primary">{t("Shared.account.emails.primary")}</Badge> : null}
        <Badge variant={isVerified ? "success" : "warning"}>
          {isVerified ? t("Shared.account.emails.verified") : t("Shared.account.emails.unverified")}
        </Badge>
      </span>
      {isPrimary ? null : (
        <span className="flex shrink-0 gap-1">
          {isVerified ? (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              disabled={isPending}
              onClick={() => run(makePrimary)}
            >
              {t("Shared.account.emails.makePrimary")}
            </Button>
          ) : (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              disabled={isPending}
              onClick={() => run(sendCode)}
            >
              {t("Shared.account.emails.verify")}
            </Button>
          )}
          <Button
            type="button"
            variant="ghost"
            size="sm"
            loading={isPending}
            onClick={() => run(remove)}
          >
            {t("Shared.account.emails.remove")}
          </Button>
        </span>
      )}
    </li>
  );
}

function AddEmailForm({
  user,
  onCreated,
  onCancel,
}: {
  user: UserResource;
  onCreated: (emailAddress: EmailAddressResource) => void;
  onCancel: () => void;
}) {
  const t = useTranslations();
  const reportError = useReportAccountError();
  const inputId = useId();
  const [email, setEmail] = useState("");
  const [isPending, startTransition] = useTransition();
  const createEmailAddress = useReverification((address: string) =>
    user.createEmailAddress({ email: address })
  );

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    startTransition(async () => {
      try {
        const emailAddress = await createEmailAddress(email.trim());
        await emailAddress.prepareVerification({ strategy: "email_code" });
        onCreated(emailAddress);
      } catch (error) {
        reportError(error);
      }
    });
  };

  return (
    <form onSubmit={submit} className="flex max-w-md flex-col gap-3">
      <div className="flex flex-col gap-1.5">
        <Label htmlFor={inputId}>{t("Shared.account.emails.newAddress")}</Label>
        <Input
          id={inputId}
          type="email"
          required
          autoComplete="email"
          value={email}
          onChange={(event) => setEmail(event.target.value)}
        />
        <p className="text-meta text-secondary">{t("Shared.account.emails.newAddressHint")}</p>
      </div>
      <div className="flex gap-2">
        <Button type="submit" size="sm" loading={isPending}>
          {t("Shared.account.emails.sendCode")}
        </Button>
        <Button type="button" variant="ghost" size="sm" disabled={isPending} onClick={onCancel}>
          {t("Shared.account.cancel")}
        </Button>
      </div>
    </form>
  );
}

function VerifyEmailForm({
  emailAddress,
  close,
}: {
  emailAddress: EmailAddressResource;
  close: () => void;
}) {
  const t = useTranslations();
  const reportError = useReportAccountError();
  const inputId = useId();
  const [code, setCode] = useState("");
  const [isPending, startTransition] = useTransition();
  const [isResending, startResend] = useTransition();

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    startTransition(async () => {
      try {
        await emailAddress.attemptVerification({ code: code.trim() });
        toast.success(
          t("Shared.account.emails.verifiedToast", { email: emailAddress.emailAddress })
        );
        close();
      } catch (error) {
        reportError(error);
      }
    });
  };

  const resend = () => {
    startResend(async () => {
      try {
        await emailAddress.prepareVerification({ strategy: "email_code" });
        toast.success(t("Shared.account.emails.codeResent"));
      } catch (error) {
        reportError(error);
      }
    });
  };

  return (
    <form onSubmit={submit} className="flex max-w-md flex-col gap-3">
      <div className="flex flex-col gap-1.5">
        <Label htmlFor={inputId}>
          {t("Shared.account.emails.enterCode", { email: emailAddress.emailAddress })}
        </Label>
        <Input
          id={inputId}
          inputMode="numeric"
          autoComplete="one-time-code"
          pattern="[0-9]{6}"
          maxLength={6}
          required
          value={code}
          onChange={(event) => setCode(event.target.value)}
        />
        <p className="text-meta text-secondary">{t("Shared.account.emails.codeHint")}</p>
      </div>
      <div className="flex flex-wrap gap-2">
        <Button type="submit" size="sm" loading={isPending}>
          {t("Shared.account.emails.confirmCode")}
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          loading={isResending}
          disabled={isPending}
          onClick={resend}
        >
          {t("Shared.account.emails.resendCode")}
        </Button>
        <Button type="button" variant="ghost" size="sm" disabled={isPending} onClick={close}>
          {t("Shared.account.cancel")}
        </Button>
      </div>
    </form>
  );
}
