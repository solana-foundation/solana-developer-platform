"use client";

import { useCallback, useState } from "react";
import type { BadgeVariant } from "@/components/ui/badge";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Callout } from "@/components/ui/callout";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useTranslations } from "@/i18n/provider";
import { createProjectRing, type ProjectRing, type ProjectRingStatus } from "./helius-rings.data";

const STATUS_BADGE: Record<ProjectRingStatus, BadgeVariant> = {
  pending: "warning",
  active: "success",
  failed: "danger",
};

/**
 * The project's one custom ring. Ops pre-deploys the ring program; submitting
 * its id here runs bring-up server-side (auditor key, config, pool
 * registration). Once active, shield operations can target the ring per
 * operation; default-ring operations are never blocked by it. A failed
 * bring-up's retry lives here too.
 *
 * Prop-driven like the other cards: the workspace owns the fetch, this card
 * owns only its form state.
 */
export function RingCard({
  ring,
  onChanged,
}: {
  ring: ProjectRing | null;
  onChanged: () => Promise<void> | void;
}) {
  const t = useTranslations();

  const [ringProgramId, setRingProgramId] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  const handleSubmit = useCallback(
    async (submittedRingProgramId: string) => {
      setSubmitting(true);
      setSubmitError(null);
      try {
        const result = await createProjectRing({ ringProgramId: submittedRingProgramId });
        if (!result.ring) {
          // The server's reason verbatim: it is the only text naming what refused.
          setSubmitError(result.error ?? t("DashboardHeliusRings.ring.submitFailed"));
        }
      } catch {
        setSubmitError(t("DashboardHeliusRings.ring.submitFailed"));
      } finally {
        setSubmitting(false);
      }
      // The row is reserved before bring-up, so a failure still leaves a ring
      // (and its recorded failure) to show.
      await onChanged();
    },
    [onChanged, t]
  );

  // A never-active ring binds no notes, so its id is correctable in place;
  // once active, the server refuses re-pointing and the input disappears.
  const canSubmitNewId = ring === null || ring.status !== "active";

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t("DashboardHeliusRings.ring.title")}</CardTitle>
        <CardDescription>{t("DashboardHeliusRings.ring.description")}</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {ring === null ? (
          <p className="text-sm text-secondary">{t("DashboardHeliusRings.ring.none")}</p>
        ) : (
          <RingDetails ring={ring} />
        )}

        {submitError ? (
          <Callout variant="danger" live>
            {submitError}
          </Callout>
        ) : null}

        {canSubmitNewId ? (
          <div className="flex flex-col gap-2">
            {ring !== null ? (
              <p className="text-sm text-secondary">{t("DashboardHeliusRings.ring.repointHint")}</p>
            ) : null}
            <div className="flex flex-wrap items-end gap-3">
              <div className="flex min-w-96 flex-col gap-1.5">
                <Label htmlFor="rings-ring-program-id">
                  {t("DashboardHeliusRings.ring.programIdLabel")}
                </Label>
                <Input
                  id="rings-ring-program-id"
                  value={ringProgramId}
                  placeholder={t("DashboardHeliusRings.ring.programIdPlaceholder")}
                  onChange={(event) => setRingProgramId(event.target.value)}
                />
              </div>
              <Button
                disabled={submitting || !ringProgramId.trim()}
                onClick={() => void handleSubmit(ringProgramId.trim())}
              >
                {t(
                  submitting
                    ? "DashboardHeliusRings.ring.submitting"
                    : "DashboardHeliusRings.ring.submit"
                )}
              </Button>
            </div>
          </div>
        ) : null}

        {/* Retry resumes bring-up with the recorded id; the input above is the
            way to re-point a never-active ring at a corrected one. */}
        {ring !== null && ring.status !== "active" ? (
          <div>
            <Button
              variant="secondary"
              disabled={submitting}
              onClick={() => void handleSubmit(ring.ringProgramId)}
            >
              {t(
                submitting
                  ? "DashboardHeliusRings.ring.submitting"
                  : "DashboardHeliusRings.ring.retry"
              )}
            </Button>
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}

function RingDetails({ ring }: { ring: ProjectRing }) {
  const t = useTranslations();

  return (
    <div className="flex flex-col gap-3 text-sm" role="status">
      <div className="flex items-center gap-2">
        <Badge variant={STATUS_BADGE[ring.status]}>
          {t(`DashboardHeliusRings.ring.status_${ring.status}`)}
        </Badge>
        <span className="text-secondary">
          {t(`DashboardHeliusRings.ring.explain_${ring.status}`)}
        </span>
      </div>

      {ring.failure ? (
        <Callout variant="danger" live>
          {ring.failure.message}
        </Callout>
      ) : null}

      <dl className="flex flex-col gap-2">
        <Field label={t("DashboardHeliusRings.ring.programId")} value={ring.ringProgramId} />
        {ring.auditorPublicKeyHex === null ? null : (
          <Field
            label={t("DashboardHeliusRings.ring.auditorKey")}
            value={ring.auditorPublicKeyHex}
          />
        )}
      </dl>
    </div>
  );
}

function Field({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-col gap-0.5">
      <dt className="text-xs text-secondary">{label}</dt>
      <dd className="break-all font-mono text-xs text-primary">{value}</dd>
    </div>
  );
}
