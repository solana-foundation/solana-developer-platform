# New organization onboarding flow

## Outcome

The first person entering a newly created organization completes a two-step setup before seeing the
dashboard:

1. Choose the organization's RPC provider.
2. Choose the organization's custody provider and provision its first sandbox wallet.
3. Redirect to the dashboard.

Onboarding belongs to the organization, not the user. A member joining an organization that has
already completed setup goes directly to the dashboard.

## Entry and routing

- Clerk still owns user signup, organization creation, organization switching, and invitations.
- The first authenticated SDP request creates the local organization mapping and default sandbox and
  production projects as it does today.
- A new organization starts with `onboarding_completed_at = null` and an onboarding version.
- Authenticated navigation to `/dashboard/**` redirects incomplete organizations to `/onboarding`.
- `/onboarding` redirects completed organizations to `/dashboard`.
- Existing organizations are backfilled as complete during migration so rollout never interrupts
  current users.
- Only an organization administrator with provider/settings permissions may complete setup. A
  non-admin who reaches an incomplete organization sees a quiet `Your organization setup is in
  progress` state with organization switching/sign-out controls.

Keep `/onboarding` outside the dashboard route group. It uses the same warm shell and white content
surface, but omits the dashboard sidebar until setup is complete.

## Screen structure

Use the existing wallet setup grammar:

- centered `max-w-3xl` form area
- two-step `WizardStepProgress`
- quiet selection cards with provider mark, name, and one-line description
- selected card uses the existing primary border and subtle fill
- persistent footer with Back/Continue actions
- Inter typography and existing SDP tokens only

Header copy:

- Title: `Set up {organization name}`
- Supporting text: `Choose the infrastructure for your team's sandbox. You can change these choices
  later.`

There is no separate welcome screen or review screen. The first useful choice is the first screen.

## Step 1 — Choose RPC

Title: `Choose your RPC provider`

Show one card for every configured RPC provider:

- SDP default RPC
- Alchemy
- Helius
- QuickNode
- Triton
- Validation Cloud

All RPCs are generally available. Do not show `Contact us`, plan labels, or manual-onboarding states.
Do not show providers whose shared credentials are missing for the environment. If none are
configured, show a blocking operational error with a support action.

Selecting a card only changes local selection. `Continue` persists the organization-level
`rpcProvider` using the existing organization settings API, then advances. Explicitly persist
`default` when it is chosen; an absent value must continue to mean that this step is incomplete.

The existing RPC connectivity test remains available later in Settings. It should not block initial
onboarding: configuration availability has already been checked, and a transient upstream failure
must not strand organization creation.

## Step 2 — Choose custody

Title: `Choose your custody provider`

Show configured, generally available custody providers only:

- Privy
- Coinbase CDP
- Para
- Turnkey

Use the provider cards from the current new-wallet form. Do not show Fireblocks, Dfns, IBM Digital
Asset Haven, Anchorage, Utila, or compliance upsells here: a manual onboarding funnel must not block
basic workspace creation. Those providers remain discoverable later in Wallets and their contextual
setup areas.

`Finish setup` performs one idempotent operation:

1. Initialize the selected organization custody provider using SDP's shared sandbox credentials.
2. Provision the organization's first wallet in the default sandbox project.
3. Label it `Default wallet` unless provider behavior supplies a stronger existing default.
4. Set it as the default wallet.
5. Verify that the explicit RPC selection and active wallet exist.
6. Set the organization's onboarding completion timestamp/version.

While provisioning, keep the user on step 2 with `Creating your sandbox wallet…`. On failure, retain
the selection, show an inline error, and offer `Try again` or another provider. Idempotency must make
retry safe if provider provisioning succeeded but completion persistence failed.

After success, navigate to `/dashboard?onboarding=complete`; the dashboard may show one restrained
`Workspace ready` toast. Do not add a third completion screen.

## Resume and back behavior

- Refresh or a later login resumes from server state.
- An explicitly stored RPC with no active custody wallet resumes on step 2.
- Back from custody returns to RPC and permits changing the organization setting.
- Leaving step 1 without continuing does not persist a selection.
- Switching organizations re-evaluates onboarding for the destination organization.
- A completed organization never re-enters onboarding merely because a user is new to that team.

## API state

Extend the existing onboarding status response:

```ts
type OrganizationOnboardingStatus = {
  linked: boolean;
  organization: Organization | null;
  setup: {
    status: "not_started" | "in_progress" | "complete";
    currentStep: "rpc" | "custody" | "complete";
    rpcProvider: OrganizationRpcProvider | null;
    custodyProvider: CustodyProvider | null;
    completedAt: string | null;
    version: number;
    canManage: boolean;
  } | null;
};
```

Status derivation:

- no explicit organization `rpcProvider` → `rpc`
- explicit RPC but no active default custody wallet → `custody`
- verified prerequisites plus completion timestamp/version → `complete`

Add an idempotent completion endpoint or server operation that verifies prerequisites before marking
complete. Never accept a client-only `completed=true` flag.

## Existing components to reuse

- `apps/sdp-web/src/app/dashboard/custody/setup/wallet-setup-flow.tsx`: provider card and stable
  wizard-footer behavior
- `apps/sdp-web/src/components/ui/wizard-step-progress.tsx`: two-step progress indicator
- `apps/sdp-web/src/app/dashboard/settings/actions.ts`: organization RPC persistence
- `apps/sdp-web/src/app/dashboard/settings/organization-rpc-settings-form.tsx`: labels and configured
  RPC handling
- `apps/sdp-web/src/app/dashboard/custody/actions.ts`: idempotent custody initialization and wallet
  creation behavior
- `apps/sdp-api/src/routes/onboarding/handlers.ts`: organization-scoped setup status

Extract a shared provider-selection card instead of copying the current wallet markup into a second
flow. RPC may add a small provider-mark component, but must keep the same card geometry and state
treatment.

## Acceptance tests

- a new organization is redirected from dashboard to RPC selection
- configured RPC providers all appear and no activation/plan copy appears
- saving an explicit RPC advances to custody and survives refresh
- only configured general custody providers appear
- choosing Para can provision the first sandbox wallet and complete onboarding
- transient custody failure retains the selection and a retry does not create duplicate configs or
  wallets
- completion requires both explicit RPC selection and an active default wallet
- completion redirects to dashboard and does not recur on later logins
- a newly invited member entering a completed organization skips onboarding
- a non-admin entering an incomplete organization cannot choose organization-wide providers
- switching to a different incomplete organization starts/resumes that organization's flow
- every preexisting organization is marked complete by migration
- self-hosted deployments show their configured provider set while keeping the same two-step flow
