"use client";

import { useUser } from "@clerk/nextjs";
import { Button } from "@sdp/ui/button";
import { SegmentedControl } from "@sdp/ui/segmented-control";
import { Textarea } from "@sdp/ui/textarea";
import * as Sentry from "@sentry/nextjs";
import { FileTextIcon, ImageIcon, PaperclipIcon, SendIcon, XIcon } from "lucide-react";
import Link from "next/link";
import { type ChangeEvent, useId, useRef, useState, useTransition } from "react";
import { useTranslations } from "@/i18n/provider";
import { dashboardFetch } from "@/lib/dashboard-fetch";
import { useProjectHref } from "@/lib/use-dashboard-project";

export const FEEDBACK_CATEGORIES = ["problem", "idea", "question"] as const;
type FeedbackCategory = (typeof FEEDBACK_CATEGORIES)[number];

const CATEGORY_LABEL_KEYS = {
  problem: "Feedback.categoryProblem",
  idea: "Feedback.categoryIdea",
  question: "Feedback.categoryQuestion",
} as const;

export const FEEDBACK_FILE_TYPES = [
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/gif",
  "application/pdf",
] as const;
export const FEEDBACK_FILE_MAX_BYTES = 10 * 1024 * 1024;
export const FEEDBACK_FILES_MAX = 5;

const HOME_HREF = "/dashboard";

interface AttachedFile {
  key: string;
  file: File;
}

function fileSize(bytes: number): string {
  return bytes < 1024 * 1024
    ? `${Math.max(1, Math.round(bytes / 1024))} KB`
    : `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/**
 * The dashboard's Send feedback screen (PRO-2421, Hoodies' `/feedback`): what it is about, what
 * the person would change, and up to five screenshots or PDFs. The words go to the SDP team's
 * inbox through the API, replying to the sender; the files and the session replay go to Sentry,
 * whose event id the email carries. Without Sentry there is nowhere to keep files, so the screen
 * takes none.
 */
export function FeedbackForm({ organizationId }: { organizationId: string }) {
  const t = useTranslations();
  const projectHref = useProjectHref();
  const { user } = useUser();
  const messageId = useId();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [category, setCategory] = useState<FeedbackCategory | "">("");
  const [message, setMessage] = useState("");
  const [files, setFiles] = useState<AttachedFile[]>([]);
  const [fileError, setFileError] = useState<string | null>(null);
  const [sendError, setSendError] = useState<string | null>(null);
  const [sent, setSent] = useState<{ files: number } | null>(null);
  const [sending, startSend] = useTransition();
  const homeHref = projectHref(HOME_HREF);
  const takesFiles = Sentry.getClient() !== undefined;
  const email = user?.primaryEmailAddress?.emailAddress ?? null;

  const pickFiles = (event: ChangeEvent<HTMLInputElement>) => {
    const picked = Array.from(event.target.files ?? []);
    event.target.value = "";
    let next = files;
    let error: string | null = null;
    for (const file of picked) {
      if (!(FEEDBACK_FILE_TYPES as readonly string[]).includes(file.type)) {
        error = t("Feedback.attachWrongType", { name: file.name });
      } else if (file.size > FEEDBACK_FILE_MAX_BYTES) {
        error = t("Feedback.attachTooLarge", { name: file.name });
      } else if (next.length >= FEEDBACK_FILES_MAX) {
        error = t("Feedback.attachTooMany", { max: String(FEEDBACK_FILES_MAX) });
      } else {
        next = [...next, { key: `${file.name}-${file.size}-${file.lastModified}`, file }];
      }
    }
    setFiles(next);
    setFileError(error);
  };

  const submit = () => {
    const trimmed = message.trim();
    if (!trimmed || sending) return;
    setSendError(null);
    startSend(async () => {
      const attachments = await Promise.all(
        files.map(async ({ file }) => ({
          filename: file.name,
          data: new Uint8Array(await file.arrayBuffer()),
          contentType: file.type,
        }))
      );
      const sentryEventId = takesFiles
        ? Sentry.captureFeedback(
            {
              message: trimmed,
              source: "dashboard",
              url: window.location.href,
              tags: category ? { feedback_category: category } : undefined,
            },
            { includeReplay: true, attachments }
          )
        : undefined;
      const result = await dashboardFetch<unknown>(
        `/api/dashboard/organizations/${encodeURIComponent(organizationId)}/feedback`,
        {
          method: "POST",
          body: {
            category: category || undefined,
            message: trimmed,
            pageUrl: window.location.href,
            attachmentCount: files.length,
            sentryEventId,
          },
        }
      );
      if (result.ok) {
        setSent({ files: files.length });
        return;
      }
      setSendError(
        result.status === 503 || result.status === null
          ? t("Feedback.unavailable")
          : t("Feedback.submitFailed", { error: result.error })
      );
    });
  };

  if (sent) {
    const body =
      email === null
        ? t("Feedback.sentBodyNoEmail")
        : sent.files === 0
          ? t("Feedback.sentBody", { email })
          : sent.files === 1
            ? t("Feedback.sentBodyOneFile", { email })
            : t("Feedback.sentBodyFiles", { email, count: String(sent.files) });
    return (
      <div className="flex flex-col items-start gap-3" role="status">
        <h2 className="text-lg font-medium text-primary">{t("Feedback.sentTitle")}</h2>
        <p className="text-body text-secondary">{body}</p>
        <Button asChild variant="outline" className="mt-3">
          <Link href={homeHref}>{t("Feedback.backTo")}</Link>
        </Button>
      </div>
    );
  }

  return (
    <form
      className="flex flex-col gap-6"
      noValidate
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
    >
      <div className="flex flex-col gap-2">
        <span className="text-field font-medium text-primary">{t("Feedback.categoryLabel")}</span>
        <SegmentedControl
          ariaLabel={t("Feedback.categoryLabel")}
          className="self-start"
          optionClassName="px-4 py-1.5 text-body"
          options={FEEDBACK_CATEGORIES.map((value) => ({
            value,
            label: t(CATEGORY_LABEL_KEYS[value]),
          }))}
          value={category}
          onChange={(value) => setCategory(value as FeedbackCategory)}
          disabled={sending}
        />
      </div>

      <div className="flex flex-col gap-2">
        <label htmlFor={messageId} className="text-field font-medium text-primary">
          {t("Feedback.messageLabel")}
        </label>
        {/* biome-ignore lint/a11y/noAutofocus: the screen exists to take this one field. */}
        <Textarea
          id={messageId}
          autoFocus
          rows={6}
          value={message}
          onChange={(event) => setMessage(event.target.value)}
          placeholder={t("Feedback.messagePlaceholder")}
          disabled={sending}
          className="resize-y text-body"
        />
      </div>

      {files.length > 0 ? (
        <ul aria-label={t("Feedback.attachedFiles")} className="-mt-2 flex flex-col gap-1">
          {files.map(({ key, file }) => {
            const Icon = file.type === "application/pdf" ? FileTextIcon : ImageIcon;
            return (
              <li key={key} className="flex items-center gap-2 text-body">
                <Icon aria-hidden="true" className="size-4 shrink-0 text-tertiary" />
                <span className="min-w-0 truncate text-primary">{file.name}</span>
                <span className="shrink-0 text-meta tabular-nums text-tertiary">
                  {fileSize(file.size)}
                </span>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  aria-label={t("Feedback.removeAttachment", { name: file.name })}
                  disabled={sending}
                  onClick={() => {
                    setFiles(files.filter((entry) => entry.key !== key));
                    setFileError(null);
                  }}
                >
                  <XIcon aria-hidden="true" />
                </Button>
              </li>
            );
          })}
        </ul>
      ) : null}

      <div className="-mt-2 flex flex-col gap-3">
        <div className="flex flex-wrap items-center justify-between gap-3">
          {takesFiles ? (
            <div className="flex flex-wrap items-center gap-3">
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={sending || files.length >= FEEDBACK_FILES_MAX}
                iconLeft={<PaperclipIcon aria-hidden="true" />}
                onClick={() => fileInputRef.current?.click()}
              >
                {t("Feedback.attach")}
              </Button>
              <span className="text-meta text-tertiary">{t("Feedback.attachHint")}</span>
              <input
                ref={fileInputRef}
                type="file"
                multiple
                accept={FEEDBACK_FILE_TYPES.join(",")}
                className="hidden"
                tabIndex={-1}
                aria-hidden="true"
                onChange={pickFiles}
              />
            </div>
          ) : (
            <span />
          )}
          <div className="flex items-center gap-2">
            <Button asChild variant="ghost">
              <Link href={homeHref}>{t("Feedback.cancel")}</Link>
            </Button>
            <Button
              type="submit"
              loading={sending}
              disabled={!message.trim()}
              iconLeft={<SendIcon aria-hidden="true" />}
            >
              {t("Feedback.submit")}
            </Button>
          </div>
        </div>
        {fileError ? (
          <p className="text-meta text-error" role="alert">
            {fileError}
          </p>
        ) : null}
        {sendError ? (
          <p className="text-meta text-secondary" role="alert">
            {sendError}
          </p>
        ) : null}
      </div>
    </form>
  );
}
