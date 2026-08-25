"use client";

import { rpcProviderNeedsEndpoint, type SafeRpcConnection } from "@sdp/types";
import { EyeIcon, EyeOffIcon } from "lucide-react";
import { useId, useState } from "react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { HoldToConfirmButton } from "@/components/ui/hold-to-confirm-button";
import { Input } from "@/components/ui/input";
import { ToggleSwitch } from "@/components/ui/toggle-switch";
import { useTranslations } from "@/i18n/provider";
import {
  activateRpcConnectionAction,
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
  pendingId: string | null;
  onAction: (action: ConnectionAction, connectionId: string) => void;
  onTest: (connectionId: string) => void;
  onRotateToggle: (connectionId: string | null) => void;
  onRotate: (connectionId: string, apiKey: string, endpointUrl: string) => void;
  rotatingId: string | null;
  testResults: Record<string, TestOutcome>;
  t: ReturnType<typeof useTranslations>;
}) {
  // Deactivating the last one puts the project back on SDP's keys, and the
  // relay says nothing when it happens, so the warning has to be here.
  const activeCount = connections.filter(
    (item) => item.status === "active" && item.scope === "project"
  ).length;

  return (
    <ul className="space-y-2">
      {connections.map((connection) => (
        <ConnectionRow
          key={connection.id}
          canManage={canManage}
          connection={connection}
          isLastActive={
            activeCount === 1 &&
            connection.status === "active" &&
            connection.scope !== "organization"
          }
          isRotating={rotatingId === connection.id}
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
 * One stored credential and the things that can be done to it.
 *
 * Split out from the list so each row's branching is counted on its own: the
 * controls a row offers depend on scope, lifecycle and whether a rotation is
 * open, and the combined function tripped the repository's complexity limit.
 */
function ConnectionRow({
  canManage,
  connection,
  isLastActive,
  isRotating,
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
  isLastActive: boolean;
  isRotating: boolean;
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
  const canActivate = connection.status !== "active" && !isDeactivated && !isOrganizationScoped;
  // A withdrawn or stranded row has nothing worth checking or replacing.
  const isLive = !isDeactivated && !isOrganizationScoped;

  return (
    <li className="space-y-3 rounded-xl border border-border-default bg-fill-subtle px-4 py-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0 space-y-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-sm font-medium text-primary">
              {connection.providerCredential.label}
            </span>
            {connection.isDefault && connection.status === "active" && !isOrganizationScoped ? (
              <Badge variant="success">{t("Shared.integrations.rpcByokServing")}</Badge>
            ) : (
              <Badge variant="outline">{connection.status}</Badge>
            )}
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
          {isOrganizationScoped ? (
            <p className="text-xs text-warning">
              {t("Shared.integrations.rpcByokOrganizationScoped")}
            </p>
          ) : null}
          {/* "What does deactivated mean?" was the question on the mock, so
                  the answer sits on the row rather than in a badge. */}
          {isDeactivated ? (
            <p className="text-xs text-tertiary">
              {t("Shared.integrations.rpcByokDeactivatedMeaning")}
            </p>
          ) : null}
          {isLastActive ? (
            <p className="text-xs text-warning">{t("Shared.integrations.rpcByokLastActive")}</p>
          ) : null}
          {/* Only ever the answer to the click that asked for it: nothing
                  about a check is stored any more (HOO-1228). */}
          {testResult ? (
            <p className={`text-xs ${testResult.ok ? "text-success" : "text-error"}`}>
              {testResult.ok
                ? t("Shared.integrations.rpcByokTestPassed")
                : (testResult.failureCode ?? t("Shared.integrations.rpcByokTestFailed"))}
            </p>
          ) : null}
        </div>

        {canManage ? (
          <div className="flex flex-wrap items-center gap-2">
            {canActivate ? (
              <Button
                type="button"
                size="sm"
                disabled={pendingId === connection.id}
                onClick={() => {
                  onAction(activateRpcConnectionAction, connection.id);
                }}
              >
                {t("Shared.integrations.rpcByokUse")}
              </Button>
            ) : null}
            {/* Live connections can be re-checked whenever somebody wants
                    to know, rather than reading a stored verdict. */}
            {isLive ? (
              <Button
                type="button"
                size="sm"
                variant="secondary"
                disabled={pendingId === connection.id}
                onClick={() => {
                  onTest(connection.id);
                }}
              >
                {t("Shared.integrations.rpcByokTest")}
              </Button>
            ) : null}
            {/* Rotation asks for the replacement up front rather than
                    leaving people to deactivate and re-add (HOO-1229). */}
            {isLive ? (
              <Button
                type="button"
                size="sm"
                variant="secondary"
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
            {isDeactivated ? (
              // Nothing left to destroy, so an ordinary button is enough.
              <Button
                type="button"
                size="sm"
                variant="secondary"
                disabled={pendingId === connection.id}
                onClick={() => {
                  onAction(deleteRpcConnectionAction, connection.id);
                }}
              >
                {t("Shared.integrations.rpcByokDelete")}
              </Button>
            ) : (
              // Held rather than clicked: this destroys the stored key and
              // there is no way back (HOO-1230).
              <HoldToConfirmButton
                label={t("Shared.integrations.rpcByokDeactivate")}
                holdingLabel={t("Shared.integrations.rpcByokDeactivateHolding")}
                disabled={pendingId === connection.id}
                onConfirm={() => {
                  onAction(deactivateRpcConnectionAction, connection.id);
                }}
              />
            )}
          </div>
        ) : null}
      </div>

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
 * Whose credentials the whole organization runs on.
 *
 * Organization-wide rather than per connection, so it sits above the list and
 * not inside a row. Its own component to keep the section's branching under
 * the repository's complexity limit.
 */
function CredentialModeCard({
  mode,
  saving,
  onChange,
  t,
}: {
  mode: "managed" | "byok";
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
  projectConnectionProvider,
  provider,
}: {
  canManage: boolean;
  /** `null` when it could not be read; the control is hidden rather than guessed. */
  credentialMode?: "managed" | "byok" | null;
  /** The provider this project already routes through, when it is not this one. */
  projectConnectionProvider?: string | null;
  /**
   * `null` when the read failed and `"restricted"` when the viewer may not make
   * it at all. Three different answers: unknown, not allowed, and none.
   */
  connections: SafeRpcConnection[] | null | "restricted";
  provider: string;
}) {
  const t = useTranslations();
  const [isFormOpen, setIsFormOpen] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [credentialLabel, setCredentialLabel] = useState("");
  const [endpointUrl, setEndpointUrl] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [showKey, setShowKey] = useState(false);
  const [testResults, setTestResults] = useState<Record<string, TestOutcome>>({});
  const [rotatingId, setRotatingId] = useState<string | null>(null);
  // Held locally so the switch reflects the change straight away; the server
  // action revalidates the page behind it.
  const [mode, setMode] = useState(credentialMode ?? "managed");
  const [isSavingMode, setIsSavingMode] = useState(false);
  const apiKeyHintId = useId();
  const endpointHintId = useId();
  const labelFieldId = useId();
  const endpointFieldId = useId();
  const apiKeyFieldId = useId();
  const needsEndpoint = rpcProviderNeedsEndpoint(provider);
  // A stranded organization row is not a connection this project can use, so
  // it must not be what stops a project connection being added.
  const hasLiveConnection =
    Array.isArray(connections) &&
    connections.some((item) => item.scope === "project" && item.status !== "deactivated");
  // A project routes through one connection whatever the provider, so another
  // provider holding it closes this page's form too.
  const takenByAnotherProvider = Boolean(projectConnectionProvider);

  const runConnectionAction = async (action: ConnectionAction, connectionId: string) => {
    setPendingId(connectionId);
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

  const submit = async () => {
    setIsSubmitting(true);
    const formData = new FormData();
    formData.set("provider", provider);
    formData.set("scope", "project");
    formData.set("credentialLabel", credentialLabel);
    formData.set("endpointUrl", endpointUrl);
    formData.set("apiKey", apiKey);

    try {
      const result = await submitRpcConnectionAction(formData);
      if (result.status === "success") {
        // Clear the secret first: a failed re-render must not leave it sitting
        // in a mounted input.
        setApiKey("");
        setCredentialLabel("");
        setEndpointUrl("");
        setIsFormOpen(false);
        setShowKey(false);
        toast.success(t("Shared.integrations.rpcByokAdded"), { position: "bottom-right" });
        return;
      }
      toast.error(result.message, { position: "bottom-right" });
    } finally {
      setIsSubmitting(false);
    }
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
        <p className="text-sm leading-6 text-tertiary">{t("Shared.integrations.rpcByokEmpty")}</p>
      )}

      {canManage && credentialMode ? (
        <CredentialModeCard
          mode={mode}
          saving={isSavingMode}
          onChange={(next) => {
            void saveMode(next);
          }}
          t={t}
        />
      ) : null}

      {canManage && (hasLiveConnection || takenByAnotherProvider) ? (
        // One per project for now (HOO-1227). Saying so is better than an Add
        // button that only ever comes back with a conflict.
        <p className="text-sm leading-6 text-tertiary">
          {takenByAnotherProvider
            ? `${t("Shared.integrations.rpcByokTakenElsewhere")} ${projectConnectionProvider}.`
            : t("Shared.integrations.rpcByokOnlyOne")}
        </p>
      ) : null}

      {canManage && !hasLiveConnection && !takenByAnotherProvider ? (
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
            {isFormOpen
              ? t("Shared.integrations.rpcByokCancel")
              : t("Shared.integrations.rpcByokAdd")}
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
              <span className="font-medium text-primary">
                {t("Shared.integrations.rpcByokLabel")}
              </span>
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
              <span className="font-medium text-primary">
                {t("Shared.integrations.rpcByokApiKey")}
              </span>
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
      ) : (
        <p className="text-sm leading-6 text-tertiary">
          {t("Shared.integrations.rpcByokAdminOnly")}
        </p>
      )}
    </div>
  );
}
