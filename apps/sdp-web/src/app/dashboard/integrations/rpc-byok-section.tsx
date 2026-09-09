"use client";

import { rpcProviderNeedsEndpoint, type SafeRpcConnection } from "@sdp/types";
import {
  ActivityIcon,
  CircleSlashIcon,
  EyeIcon,
  EyeOffIcon,
  RefreshCwIcon,
  Trash2Icon,
} from "lucide-react";
import { useId, useState } from "react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Callout } from "@/components/ui/callout";
import { Input } from "@/components/ui/input";
import { ToggleSwitch } from "@/components/ui/toggle-switch";
import { useTranslations } from "@/i18n/provider";
import { rpcProviderLabel } from "@/lib/rpc-providers";
import {
  deactivateRpcConnectionAction,
  deleteRpcConnectionAction,
  rotateRpcConnectionAction,
  setRpcCredentialModeAction,
  submitRpcConnectionAction,
  testRpcConnectionAction,
} from "./rpc-connection-actions";

/**
 * Every row control posts a connection id and reads back a status. Delete
 * answers `deleted` rather than a connection, so the shared handler is typed on
 * what they have in common rather than on one of them.
 */
type ConnectionAction = (
  formData: FormData
) => Promise<{ status: string; message?: string } | { status: "deleted" }>;

/** What a manual check answered, held per row and never persisted. */
type TestOutcome = { ok: boolean; failureCode: string | null };

type TranslationKey = Parameters<ReturnType<typeof useTranslations>>[0];

/**
 * The stored-credential rows.
 *
 * Extracted so the section's own branching stays under the repository's
 * cognitive-complexity limit: the list has its own per-row state to reason
 * about and reads better on its own.
 */
function ConnectionList({
  canManage,
  connections,
  failsClosed,
  liveProjectConnections,
  pendingId,
  onAction,
  onTest,
  onRotateToggle,
  onRotate,
  rotatingId,
  testResults,
  t,
}: {
  canManage: boolean;
  connections: SafeRpcConnection[];
  /** The organization runs on its own keys, so losing this one stops RPC. */
  failsClosed: boolean;
  /** Across every provider — `connections` is narrowed to the one on this page. */
  liveProjectConnections: number;
  pendingId: string | null;
  onAction: (action: ConnectionAction, connectionId: string) => void;
  onTest: (connectionId: string) => void;
  onRotateToggle: (connectionId: string | null) => void;
  onRotate: (connectionId: string, apiKey: string, endpointUrl: string) => void;
  rotatingId: string | null;
  testResults: Record<string, TestOutcome>;
  t: ReturnType<typeof useTranslations>;
}) {
  // Deactivating what is serving puts the project back on SDP's keys, and the
  // relay says nothing when it happens, so the warning has to be here.
  //
  // Counted across providers rather than inside `connections`, which the page
  // has already narrowed to this one: a per-page count is at most 1, so every
  // provider's own key claimed to be the only thing routing the project.
  const hasSpare = liveProjectConnections > 1;

  return (
    <ul className="space-y-2">
      {connections.map((connection) => (
        <ConnectionRow
          key={connection.id}
          canManage={canManage}
          connection={connection}
          hasSpare={hasSpare}
          isRotating={rotatingId === connection.id}
          failsClosed={failsClosed}
          pendingId={pendingId}
          onAction={onAction}
          onTest={onTest}
          onRotateToggle={onRotateToggle}
          onRotate={onRotate}
          testResult={testResults[connection.id]}
          t={t}
        />
      ))}
    </ul>
  );
}

/**
 * Which of three things this row is: carrying traffic, proven and idle, or
 * neither.
 *
 * Its own function because "active" and "serving" stopped being the same
 * thing once a project could hold a key per provider, and the distinction is
 * the first question anyone asks of this list.
 */
function ConnectionStatusBadge({
  connection,
  isLive,
  isServing,
  t,
}: {
  connection: SafeRpcConnection;
  isLive: boolean;
  isServing: boolean;
  t: ReturnType<typeof useTranslations>;
}) {
  if (isServing) {
    return <Badge variant="success">{t("Shared.integrations.rpcByokServing")}</Badge>;
  }
  // Proven and idle: a key that works and routes nothing, waiting to be
  // switched to. "active" alone read as though it were the one serving.
  if (isLive && connection.status === "active") {
    return <Badge variant="outline">{t("Shared.integrations.rpcByokReady")}</Badge>;
  }
  return <Badge variant="outline">{connection.status}</Badge>;
}

/** A line under the badge: which message, and how loudly to say it. */
type RowNote = { key: TranslationKey; tone: string };

/**
 * Which lines a row shows under its badge, in the order they are read.
 *
 * A plain function rather than more props on the component below: deciding
 * this took five flags, and a component taking five booleans has thirty-two
 * shapes nobody can hold in their head or test. The component renders what
 * this returns and branches on nothing.
 */
function resolveRowNotes(input: {
  failsClosed: boolean;
  hasSpare: boolean;
  isDeactivated: boolean;
  isOrganizationScoped: boolean;
  isServing: boolean;
}): RowNote[] {
  const notes: RowNote[] = [];

  if (input.isOrganizationScoped) {
    notes.push({ key: "Shared.integrations.rpcByokOrganizationScoped", tone: "text-warning" });
  }
  // "What does deactivated mean?" was the question on the mock, so the answer
  // sits on the row rather than in a badge.
  if (input.isDeactivated) {
    notes.push({ key: "Shared.integrations.rpcByokDeactivatedMeaning", tone: "text-tertiary" });
  }
  // Only on the row actually carrying traffic. A Ready key routes nothing, so
  // warning that removing it changes where requests go was simply false, and
  // it appeared on every provider's page at once because the count behind it
  // came from a list narrowed to one.
  //
  // Only the fail-closed case is a warning. The rest describes where traffic
  // goes if this key is withdrawn, which is ordinary context and was being
  // shouted in amber beside a green "Serving traffic" badge.
  if (input.isServing) {
    if (input.hasSpare) {
      notes.push({ key: "Shared.integrations.rpcByokServingHasSpare", tone: "text-tertiary" });
    } else if (input.failsClosed) {
      notes.push({ key: "Shared.integrations.rpcByokLastActiveByok", tone: "text-warning" });
    } else {
      notes.push({ key: "Shared.integrations.rpcByokLastActive", tone: "text-tertiary" });
    }
  }

  return notes;
}

/**
 * What the row has to say about itself beyond its badge.
 *
 * Its own component for the same reason the badge is: the row's controls and
 * its explanations are two separate pieces of branching, and counting them
 * together put `ConnectionRow` over the repository's complexity limit.
 */
function ConnectionRowNotes({
  notes,
  testResult,
  t,
}: {
  notes: readonly RowNote[];
  testResult: TestOutcome | undefined;
  t: ReturnType<typeof useTranslations>;
}) {
  return (
    <>
      {notes.map((note) => (
        <p key={note.key} className={`text-xs ${note.tone}`}>
          {t(note.key)}
        </p>
      ))}
      {/* Only ever the answer to the click that asked for it: nothing about a
          check is stored any more (HOO-1228). */}
      {testResult ? (
        <p className={`text-xs ${testResult.ok ? "text-success" : "text-error"}`}>
          {testResult.ok
            ? t("Shared.integrations.rpcByokTestPassed")
            : (testResult.failureCode ?? t("Shared.integrations.rpcByokTestFailed"))}
        </p>
      ) : null}
    </>
  );
}

/**
 * One stored credential and the things that can be done to it.
 *
 * Split out from the list so each row's branching is counted on its own: the
 * controls a row offers depend on scope, lifecycle and whether a rotation is
 * open, and the combined function tripped the repository's complexity limit.
 */
function ConnectionRow({
  canManage,
  connection,
  hasSpare,
  isRotating,
  failsClosed,
  pendingId,
  onAction,
  onTest,
  onRotateToggle,
  onRotate,
  testResult,
  t,
}: {
  canManage: boolean;
  connection: SafeRpcConnection;
  /** Another live connection on some other provider could take this one's place. */
  hasSpare: boolean;
  isRotating: boolean;
  failsClosed: boolean;
  pendingId: string | null;
  onAction: (action: ConnectionAction, connectionId: string) => void;
  onTest: (connectionId: string) => void;
  onRotateToggle: (connectionId: string | null) => void;
  onRotate: (connectionId: string, apiKey: string, endpointUrl: string) => void;
  testResult: TestOutcome | undefined;
  t: ReturnType<typeof useTranslations>;
}) {
  // Pre-HOO-1226 rows. The relay no longer resolves them, so activating
  // one would report success and route nothing.
  const isOrganizationScoped = connection.scope === "organization";
  // Deactivation destroys the secret, so the API refuses to reactivate
  // (409). Offering the control anyway was a button that could only ever
  // produce an error (HOO-1219).
  const isDeactivated = connection.status === "deactivated";
  // What the relay routes through: one default per project, not merely one
  // that works. A project can hold a proven key per provider.
  const isServing = connection.isDefault && connection.status === "active" && !isOrganizationScoped;
  // A withdrawn or stranded row has nothing worth checking or replacing.
  const isLive = !isDeactivated && !isOrganizationScoped;
  // Delete used to fire on a single click with nothing in between. It only ever
  // removes a row whose secret is already gone, so a second look is enough --
  // but "enough" is not "none".
  const [confirmingDelete, setConfirmingDelete] = useState(false);

  return (
    <li className="space-y-3 rounded-xl border border-border-default bg-fill-subtle px-4 py-3">
      {/* The status block owns the full width and the controls sit on their own
          line beneath it. Sharing one line only worked while the notes were
          short: a row explaining why it is not routing pushed the buttons onto
          a second line anyway, but ragged and full-bleed. */}
      <div className="min-w-0 space-y-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-sm font-medium text-primary">
            {connection.providerCredential.label}
          </span>
          <ConnectionStatusBadge
            connection={connection}
            isLive={isLive}
            isServing={isServing}
            t={t}
          />
        </div>
        <p className="text-xs text-tertiary">
          {connection.network}
          {typeof connection.displayMetadata.endpointHost === "string"
            ? ` · ${connection.displayMetadata.endpointHost}`
            : ""}
          {typeof connection.displayMetadata.apiKeySuffix === "string"
            ? ` · ····${connection.displayMetadata.apiKeySuffix}`
            : ""}
        </p>
        <ConnectionRowNotes
          notes={resolveRowNotes({
            failsClosed,
            hasSpare,
            isDeactivated,
            isOrganizationScoped,
            isServing,
          })}
          testResult={testResult}
          t={t}
        />
      </div>

      {canManage ? (
        /* One action group, one place, whatever state the row is in. The
           lifecycle controls keep a fixed order left to right -- rotate,
           deactivate, delete -- so the same action never moves between states,
           and the check sits apart on the right because it is both the most
           reached for and the only one that changes nothing. */
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex flex-wrap items-center gap-1">
            {/* Rotation asks for the replacement up front rather than
                  leaving people to deactivate and re-add (HOO-1229). */}
            {isLive ? (
              <Button
                type="button"
                size="sm"
                variant="ghost"
                iconLeft={<RefreshCwIcon />}
                aria-expanded={isRotating}
                disabled={pendingId === connection.id}
                onClick={() => {
                  onRotateToggle(isRotating ? null : connection.id);
                }}
              >
                {isRotating
                  ? t("Shared.integrations.rpcByokCancel")
                  : t("Shared.integrations.rpcByokRotate")}
              </Button>
            ) : null}
            {/* Offered on every row that is not already deactivated, which
                  includes stranded organization-scoped rows -- those cannot be
                  rotated or checked, so this is their only way out. */}
            {isDeactivated ? null : (
              <Button
                type="button"
                size="sm"
                variant="ghost"
                iconLeft={<CircleSlashIcon />}
                disabled={pendingId === connection.id}
                onClick={() => {
                  onAction(deactivateRpcConnectionAction, connection.id);
                }}
              >
                {t("Shared.integrations.rpcByokDeactivate")}
              </Button>
            )}
            {/* Secondary styling rather than red: this control only opens the
                  question, and the strip it opens carries the warning. Red on
                  both said "danger" twice for one decision. */}
            {isDeactivated ? (
              <Button
                type="button"
                size="sm"
                variant="ghost"
                iconLeft={<Trash2Icon />}
                aria-expanded={confirmingDelete}
                disabled={pendingId === connection.id}
                onClick={() => {
                  setConfirmingDelete(true);
                }}
              >
                {t("Shared.integrations.rpcByokDelete")}
              </Button>
            ) : null}
          </div>
          {/* No per-key switch here. "Use this provider" above does the same
                thing on this page and also moves the organization's selection
                with it, so a key and the provider it belongs to can no longer
                be pointed in two directions. */}
          {/* Live connections can be re-checked whenever somebody wants to
                know, rather than reading a stored verdict. */}
          {isLive ? (
            <Button
              type="button"
              size="sm"
              variant="secondary"
              iconLeft={<ActivityIcon />}
              disabled={pendingId === connection.id}
              onClick={() => {
                onTest(connection.id);
              }}
            >
              {t("Shared.integrations.rpcByokTest")}
            </Button>
          ) : null}
        </div>
      ) : null}

      {/* Answered where it was asked, rather than over the top of the page. The
          row is already the thing being talked about, so a modal would only
          hide it behind the question about it. */}
      {confirmingDelete ? (
        <Callout
          live
          variant="danger"
          className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between"
        >
          <p>{t("Shared.integrations.rpcByokDeleteConfirm")}</p>
          <div className="flex shrink-0 items-center gap-2">
            <Button
              type="button"
              size="sm"
              variant="ghost"
              onClick={() => {
                setConfirmingDelete(false);
              }}
            >
              {t("Shared.integrations.rpcByokCancel")}
            </Button>
            {/* Named for the connection rather than just "Delete": while the
                strip is open the row carries two buttons reading Delete, and
                the one that actually destroys the record should not be the
                ambiguous one to anything reading the page aloud. */}
            <Button
              type="button"
              size="sm"
              variant="destructive"
              iconLeft={<Trash2Icon />}
              aria-label={t("Shared.integrations.rpcByokDeleteNamed", {
                name: connection.providerCredential.label,
              })}
              disabled={pendingId === connection.id}
              onClick={() => {
                setConfirmingDelete(false);
                onAction(deleteRpcConnectionAction, connection.id);
              }}
            >
              {t("Shared.integrations.rpcByokDelete")}
            </Button>
          </div>
        </Callout>
      ) : null}

      {isRotating ? (
        <RotateForm
          connectionId={connection.id}
          needsEndpoint={rpcProviderNeedsEndpoint(connection.provider)}
          pending={pendingId === connection.id}
          onRotate={onRotate}
          t={t}
        />
      ) : null}
    </li>
  );
}

/**
 * Why there is no list. Two different answers that must not be confused: not
 * permitted is a settled fact, a failed read is not, so only the second gets a
 * warning and an invitation to retry.
 */
function ConnectionsUnavailable({
  reason,
  t,
}: {
  reason: "restricted" | null;
  t: ReturnType<typeof useTranslations>;
}) {
  return reason === "restricted" ? (
    <p className="text-sm leading-6 text-tertiary">{t("Shared.integrations.rpcByokRestricted")}</p>
  ) : (
    <p className="text-sm leading-6 text-warning">{t("Shared.integrations.rpcByokUnavailable")}</p>
  );
}

/**
 * Adding a credential.
 *
 * Its own component so the fields, and the key in particular, live and die with
 * the open form: collapsing it must not leave a secret sitting in a mounted
 * input, and the parent holding that state made it the largest component in
 * the file.
 */
function AddConnectionForm({
  needsEndpoint,
  onAdd,
  t,
}: {
  needsEndpoint: boolean;
  /** Resolves true when the connection was stored, so the form can clear. */
  onAdd: (label: string, endpointUrl: string, apiKey: string) => Promise<boolean>;
  t: ReturnType<typeof useTranslations>;
}) {
  const [isFormOpen, setIsFormOpen] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [credentialLabel, setCredentialLabel] = useState("");
  const [endpointUrl, setEndpointUrl] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [showKey, setShowKey] = useState(false);
  const apiKeyHintId = useId();
  const endpointHintId = useId();
  const labelFieldId = useId();
  const endpointFieldId = useId();
  const apiKeyFieldId = useId();

  const submit = async () => {
    setIsSubmitting(true);
    try {
      const stored = await onAdd(credentialLabel, endpointUrl, apiKey);
      if (!stored) {
        return;
      }
      // Clear the secret first: a failed re-render must not leave it sitting
      // in a mounted input.
      setApiKey("");
      setCredentialLabel("");
      setEndpointUrl("");
      setIsFormOpen(false);
      setShowKey(false);
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div className="space-y-3">
      {/* Collapsed by default: most visits are to read what is connected,
              not to add a credential, and a permanently open secret field is
              noise on a page that is mostly status. */}
      <Button
        type="button"
        variant={isFormOpen ? "secondary" : "default"}
        aria-expanded={isFormOpen}
        aria-controls="rpc-byok-form"
        onClick={() => setIsFormOpen((open) => !open)}
      >
        {isFormOpen ? t("Shared.integrations.rpcByokCancel") : t("Shared.integrations.rpcByokAdd")}
      </Button>

      <form
        id="rpc-byok-form"
        hidden={!isFormOpen}
        className="grid gap-4 rounded-xl border border-border-default p-4"
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        {/* No network field: the project decides it (HOO-1221). A sandbox
                project is devnet and a production one is mainnet, and the key
                itself is the same either way, so asking only created a way for
                the two to disagree. */}
        <label className="grid gap-1.5 text-sm" htmlFor={labelFieldId}>
          <span className="font-medium text-primary">{t("Shared.integrations.rpcByokLabel")}</span>
          <Input
            id={labelFieldId}
            required
            value={credentialLabel}
            onChange={(event) => setCredentialLabel(event.target.value)}
            placeholder={t("Shared.integrations.rpcByokLabelPlaceholder")}
          />
        </label>

        {/* Only providers that issue an account-specific host make the
                tenant type one; for the rest the published endpoint is used. */}
        {needsEndpoint ? (
          <label className="grid gap-1.5 text-sm" htmlFor={endpointFieldId}>
            <span className="font-medium text-primary">
              {t("Shared.integrations.rpcByokEndpoint")}
            </span>
            <Input
              id={endpointFieldId}
              required
              type="url"
              aria-describedby={endpointHintId}
              value={endpointUrl}
              onChange={(event) => setEndpointUrl(event.target.value)}
              placeholder="https://your-endpoint.example"
            />
            {/* Described by, not labelled by: hint text inside the label
                    becomes part of the field's accessible name. */}
            <span id={endpointHintId} className="text-xs text-tertiary">
              {t("Shared.integrations.rpcByokEndpointHint")}{" "}
              {/* Rendered as an element, not copy: translate() reads braces
                    in a message as an interpolation slot and throws on render. */}
              <code className="rounded bg-fill-subtle px-1 font-mono">{"{API_KEY}"}</code>
            </span>
          </label>
        ) : null}

        <label className="grid gap-1.5 text-sm" htmlFor={apiKeyFieldId}>
          <span className="font-medium text-primary">{t("Shared.integrations.rpcByokApiKey")}</span>
          <div className="flex items-center gap-2">
            <Input
              id={apiKeyFieldId}
              required
              className="flex-1"
              type={showKey ? "text" : "password"}
              autoComplete="off"
              aria-describedby={apiKeyHintId}
              value={apiKey}
              onChange={(event) => setApiKey(event.target.value)}
            />
            {/* A typo in a masked field is the usual reason a first
                    activation fails, so the value is checkable before saving. */}
            <Button
              type="button"
              variant="secondary"
              size="sm"
              aria-pressed={showKey}
              // The icon carries no text, so the control needs its own name.
              aria-label={
                showKey
                  ? t("Shared.integrations.rpcByokHideKey")
                  : t("Shared.integrations.rpcByokShowKey")
              }
              onClick={() => setShowKey((shown) => !shown)}
            >
              {showKey ? (
                <EyeOffIcon aria-hidden className="size-4" />
              ) : (
                <EyeIcon aria-hidden className="size-4" />
              )}
            </Button>
          </div>
          <span id={apiKeyHintId} className="text-xs text-tertiary">
            {t("Shared.integrations.rpcByokApiKeyHint")}
          </span>
        </label>

        <div>
          <Button type="submit" disabled={isSubmitting}>
            {isSubmitting
              ? t("Shared.integrations.rpcByokAdding")
              : t("Shared.integrations.rpcByokSave")}
          </Button>
        </div>
      </form>
    </div>
  );
}

/**
 * Whose credentials the whole organization runs on.
 *
 * Organization-wide rather than per connection, so it sits above the list and
 * not inside a row. Its own component to keep the section's branching under
 * the repository's complexity limit.
 */
function CredentialModeCard({
  mode,
  stranded,
  saving,
  onChange,
  t,
}: {
  mode: "managed" | "byok";
  /** On its own keys with nothing live: every RPC call is failing right now. */
  stranded: boolean;
  saving: boolean;
  onChange: (next: "managed" | "byok") => void;
  t: ReturnType<typeof useTranslations>;
}) {
  return (
    <div className="flex flex-wrap items-start justify-between gap-3 rounded-xl border border-border-default px-4 py-3">
      <div className="min-w-0 space-y-1">
        <p className="text-sm font-medium text-primary">{t("Shared.integrations.rpcModeTitle")}</p>
        <p className="max-w-2xl text-xs leading-5 text-tertiary">
          {mode === "byok"
            ? t("Shared.integrations.rpcModeByokHint")
            : t("Shared.integrations.rpcModeManagedHint")}
        </p>
        {stranded ? (
          <p className="max-w-2xl text-xs leading-5 text-error">
            {t("Shared.integrations.rpcModeStranded")}
          </p>
        ) : null}
      </div>
      <ToggleSwitch
        checked={mode === "byok"}
        disabled={saving}
        // The switch renders no text of its own, so it needs a name.
        aria-label={t("Shared.integrations.rpcModeToggle")}
        onChange={(next) => onChange(next ? "byok" : "managed")}
      />
    </div>
  );
}

/**
 * The replacement key, asked for in place.
 *
 * Its own component so the value lives and dies with the open form: a key
 * typed here must not survive the row being collapsed, and per-row state in
 * the list would outlive it.
 */
function RotateForm({
  connectionId,
  needsEndpoint,
  pending,
  onRotate,
  t,
}: {
  connectionId: string;
  needsEndpoint: boolean;
  pending: boolean;
  onRotate: (connectionId: string, apiKey: string, endpointUrl: string) => void;
  t: ReturnType<typeof useTranslations>;
}) {
  const [apiKey, setApiKey] = useState("");
  const [endpointUrl, setEndpointUrl] = useState("");
  const keyFieldId = useId();
  const endpointFieldId = useId();

  return (
    <form
      className="grid gap-3 border-t border-border-default pt-3"
      onSubmit={(event) => {
        event.preventDefault();
        onRotate(connectionId, apiKey, endpointUrl);
      }}
    >
      <p className="text-xs text-tertiary">{t("Shared.integrations.rpcByokRotateHint")}</p>
      {needsEndpoint ? (
        <label className="grid gap-1.5 text-sm" htmlFor={endpointFieldId}>
          <span className="font-medium text-primary">
            {t("Shared.integrations.rpcByokEndpoint")}
          </span>
          <Input
            id={endpointFieldId}
            required
            type="url"
            value={endpointUrl}
            onChange={(event) => setEndpointUrl(event.target.value)}
            placeholder="https://your-endpoint.example"
          />
        </label>
      ) : null}
      <label className="grid gap-1.5 text-sm" htmlFor={keyFieldId}>
        <span className="font-medium text-primary">
          {t("Shared.integrations.rpcByokNewApiKey")}
        </span>
        <Input
          id={keyFieldId}
          required
          type="password"
          autoComplete="off"
          value={apiKey}
          onChange={(event) => setApiKey(event.target.value)}
        />
      </label>
      <div>
        <Button type="submit" size="sm" disabled={pending}>
          {t("Shared.integrations.rpcByokRotateSave")}
        </Button>
      </div>
    </form>
  );
}

/**
 * Tenant-owned credentials for one provider (HOO-1090).
 *
 * The key field is write-only by construction: it is cleared on submit and the
 * API's response type carries no field that could return it, so nothing here
 * can repopulate a stored secret.
 */
export function RpcByokSection({
  canManage,
  connections,
  credentialMode,
  liveConnectionCount = 0,
  liveProjectConnections = 0,
  servingProvider,
  provider,
}: {
  canManage: boolean;
  /** `null` when it could not be read; the control is hidden rather than guessed. */
  credentialMode?: "managed" | "byok" | null;
  /** Live connections across the whole organization, not just this provider. */
  liveConnectionCount?: number;
  /** Live connections this project holds across every provider. */
  liveProjectConnections?: number;
  /**
   * The provider whose connection actually carries this project's traffic, when
   * it is not this one. Must be the serving connection and not merely any key
   * the project holds elsewhere — the copy below says traffic runs there, and
   * a project can hold a proven key per provider with only one of them serving.
   */
  servingProvider?: string | null;
  /**
   * `null` when the read failed and `"restricted"` when the viewer may not make
   * it at all. Three different answers: unknown, not allowed, and none.
   */
  connections: SafeRpcConnection[] | null | "restricted";
  provider: string;
}) {
  const t = useTranslations();
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [testResults, setTestResults] = useState<Record<string, TestOutcome>>({});
  const [rotatingId, setRotatingId] = useState<string | null>(null);
  // Held locally so the switch reflects the change straight away; the server
  // action revalidates the page behind it.
  const [mode, setMode] = useState(credentialMode ?? "managed");
  const [isSavingMode, setIsSavingMode] = useState(false);
  const needsEndpoint = rpcProviderNeedsEndpoint(provider);
  // A stranded organization row is not a connection this project can use, so
  // it must not be what stops a project connection being added.
  const hasLiveConnection =
    Array.isArray(connections) &&
    connections.some((item) => item.scope === "project" && item.status !== "deactivated");
  // Context, never a blocker: a project holds a key per provider, and adding one
  // here is exactly how you get a second one to switch to.
  const servedElsewhere = Boolean(servingProvider) && servingProvider !== provider;

  /** A check describes the connection as it was; any change makes it a lie. */
  const forgetTest = (connectionId: string) =>
    setTestResults((current) => {
      const { [connectionId]: _dropped, ...rest } = current;
      return rest;
    });

  const runConnectionAction = async (action: ConnectionAction, connectionId: string) => {
    setPendingId(connectionId);
    forgetTest(connectionId);
    const formData = new FormData();
    formData.set("connectionId", connectionId);
    formData.set("provider", provider);
    try {
      const result = await action(formData);
      if (result.status === "success") {
        toast.success(t("Shared.integrations.rpcByokUpdated"), { position: "bottom-right" });
      } else if (result.status === "deleted") {
        toast.success(t("Shared.integrations.rpcByokDeleted"), { position: "bottom-right" });
      } else {
        toast.error("message" in result ? result.message : undefined, { position: "bottom-right" });
      }
    } finally {
      setPendingId(null);
    }
  };

  const runTest = async (connectionId: string) => {
    setPendingId(connectionId);
    forgetTest(connectionId);
    const formData = new FormData();
    formData.set("connectionId", connectionId);
    try {
      const result = await testRpcConnectionAction(formData);
      if (result.status === "tested") {
        setTestResults((current) => ({
          ...current,
          [connectionId]: { ok: result.ok, failureCode: result.failureCode },
        }));
        return;
      }
      toast.error(result.message, { position: "bottom-right" });
    } finally {
      setPendingId(null);
    }
  };

  const saveMode = async (next: "managed" | "byok") => {
    setIsSavingMode(true);
    const formData = new FormData();
    formData.set("mode", next);
    formData.set("provider", provider);
    try {
      const result = await setRpcCredentialModeAction(formData);
      if (result.status === "saved") {
        setMode(next);
        toast.success(t("Shared.integrations.rpcModeSaved"), { position: "bottom-right" });
        return;
      }
      // Refused, so the switch must not look like it moved.
      toast.error(result.message, { position: "bottom-right" });
    } finally {
      setIsSavingMode(false);
    }
  };

  const runRotate = async (connectionId: string, apiKey: string, endpointUrl: string) => {
    setPendingId(connectionId);
    const formData = new FormData();
    formData.set("connectionId", connectionId);
    formData.set("provider", provider);
    formData.set("apiKey", apiKey);
    formData.set("endpointUrl", endpointUrl);
    forgetTest(connectionId);
    try {
      const result = await rotateRpcConnectionAction(formData);
      if (result.status === "success") {
        // Closed before the toast: the field holding the new key must not
        // stay mounted once it has been accepted.
        setRotatingId(null);
        toast.success(t("Shared.integrations.rpcByokRotated"), { position: "bottom-right" });
        return;
      }
      toast.error(result.message, { position: "bottom-right" });
    } finally {
      setPendingId(null);
    }
  };

  /** Returns whether the connection was stored, so the form knows to clear. */
  const handleAdd = async (label: string, endpoint: string, key: string) => {
    const formData = new FormData();
    formData.set("provider", provider);
    formData.set("scope", "project");
    formData.set("credentialLabel", label);
    formData.set("endpointUrl", endpoint);
    formData.set("apiKey", key);

    const result = await submitRpcConnectionAction(formData);
    if (result.status === "success") {
      toast.success(t("Shared.integrations.rpcByokAdded"), { position: "bottom-right" });
      return true;
    }
    toast.error(result.message, { position: "bottom-right" });
    return false;
  };

  return (
    <div className="space-y-5" data-rpc-byok={provider}>
      <p className="max-w-3xl text-sm leading-6 text-pretty text-secondary">
        {t("Shared.integrations.rpcByokDescription")}
      </p>

      {connections === "restricted" || connections === null ? (
        <ConnectionsUnavailable reason={connections} t={t} />
      ) : connections.length > 0 ? (
        <ConnectionList
          canManage={canManage}
          connections={connections}
          failsClosed={mode === "byok"}
          liveProjectConnections={liveProjectConnections}
          pendingId={pendingId}
          onAction={(action, id) => {
            void runConnectionAction(action, id);
          }}
          onTest={(id) => {
            void runTest(id);
          }}
          onRotateToggle={setRotatingId}
          onRotate={(id, key, endpoint) => {
            void runRotate(id, key, endpoint);
          }}
          rotatingId={rotatingId}
          testResults={testResults}
          t={t}
        />
      ) : (
        <p className="text-sm leading-6 text-tertiary">
          {/* "Running on SDP's" is only true when nothing of the tenant's own
              serves this project. Another provider's connection carrying the
              traffic is exactly the case where it is false. */}
          {servedElsewhere
            ? t("Shared.integrations.rpcByokEmptyRoutedElsewhere", {
                provider: rpcProviderLabel(servingProvider ?? ""),
              })
            : t("Shared.integrations.rpcByokEmpty")}
        </p>
      )}

      {canManage && credentialMode ? (
        <CredentialModeCard
          mode={mode}
          stranded={mode === "byok" && liveConnectionCount === 0}
          saving={isSavingMode}
          onChange={(next) => {
            void saveMode(next);
          }}
          t={t}
        />
      ) : null}

      {/* A project holds a key per provider, so only this provider already
          having one closes the form. Another provider serving is context, not
          a blocker: adding here is how you get a second one to switch to. */}
      {canManage && hasLiveConnection ? (
        <p className="text-sm leading-6 text-tertiary">{t("Shared.integrations.rpcByokOnlyOne")}</p>
      ) : null}

      {canManage && !hasLiveConnection ? (
        <>
          {servedElsewhere ? (
            <p className="text-sm leading-6 text-tertiary">
              {t("Shared.integrations.rpcByokAddAlongside", {
                provider: rpcProviderLabel(servingProvider ?? ""),
              })}
            </p>
          ) : null}
          <AddConnectionForm needsEndpoint={needsEndpoint} onAdd={handleAdd} t={t} />
        </>
      ) : null}

      {/* Only a viewer who cannot manage needs telling why there is no form.
          An admin already read the reason above, and being told they are not
          an admin is worse than silence. */}
      {canManage ? null : (
        <p className="text-sm leading-6 text-tertiary">
          {t("Shared.integrations.rpcByokAdminOnly")}
        </p>
      )}
    </div>
  );
}
