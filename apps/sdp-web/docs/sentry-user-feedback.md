# Sentry User Feedback

## Overview

The SDP dashboard includes an in-product feedback widget powered by [Sentry User Feedback](https://docs.sentry.io/product/user-feedback/). Users can report issues directly from the dashboard sidebar. Each submission is enriched with page context, session replay (when available), and optional screenshots.

Feedback submissions are routed automatically into Linear as reported issues via a Sentry Alert Rule.

## Where it appears

- **Dashboard sidebar** — a "Feedback" button in the bottom nav area (above "API Docs" and "Settings")
- **Global error page** — a "Report this issue" button appears alongside the "Try again" button when an unhandled error occurs

## Architecture

```
User clicks "Feedback" in sidebar
  → Sentry feedback modal opens (async-loaded)
  → User fills in message, optionally attaches screenshot
  → Submission sent to Sentry as a User Feedback event
    → Enriched with: page URL, user identity (Clerk), org ID tag, session replay link
  → Sentry Issue Alert fires (filter: issue.category = feedback)
    → Linear issue created automatically in configured team/project
```

## Configuration

### Client integration

Defined in `src/instrumentation-client.ts`:

- `feedbackIntegration` with `autoInject: false` — no floating button; the sidebar component triggers the modal
- `enableScreenshot: true` — users can attach screenshots
- `colorScheme: "light"` with `themeLight` matching the Solana Design System (beige `#e9e7de` background, dark `#1c1c1d` text)

### User context

`SentryUserContext` (`src/components/sentry-user-context.tsx`) sets `Sentry.setUser()` from Clerk auth on every dashboard page load. This enriches all Sentry events (errors, replays, feedback) with user identity. It also tags the `clerk.orgId` for org-level filtering.

The feedback form auto-populates name and email from this user context via the SDK's `useSentryUser` default.

### Widget component

`SentryFeedbackWidget` (`src/components/sentry-feedback-widget.tsx`) renders a button in the sidebar and uses `Sentry.getFeedback()?.attachTo()` to bind the feedback modal trigger.

## Sentry dashboard setup

### 1. Enable the Linear integration

1. Go to **Sentry > Settings > Integrations > Linear**
2. Authenticate with Linear OAuth
3. Map the **sdp-web** Sentry project to the target Linear team

### 2. Create an Issue Alert rule

1. Go to **Sentry > Alerts > Create Alert Rule > Issue Alert**
2. **When:** A new issue is created
3. **Filter:** `issue.category` equals `feedback`
4. **Then:** Create a Linear issue → select team, project, and labels (e.g., `user-feedback`)
5. **Name:** "User Feedback → Linear"
6. **Frequency:** Perform actions for every new issue (no throttle)

## Privacy

- `sendDefaultPii` is `false` — no automatic PII collection
- Session replay masks all text (`maskAllText: true`) and blocks all media (`blockAllMedia: true`)
- User identity is set explicitly via `Sentry.setUser({ id, email })` from Clerk auth
- Users can see and edit the pre-populated name/email before submitting feedback
- Screenshots are user-initiated and user-reviewed before submission

## Operational expectations

- Every feedback submission appears as a Sentry issue under the **User Feedback** category
- Each unique feedback creates one Linear issue (Sentry deduplicates by issue fingerprint)
- Session replays are linked automatically if the session was being recorded
- Screenshots are attached if the user takes one

## Troubleshooting

| Symptom | Check |
|---|---|
| Feedback button doesn't appear | Verify `NEXT_PUBLIC_SENTRY_DSN` is set and the `feedbackIntegration` is in `instrumentation-client.ts` |
| Modal doesn't open on click | Check browser console for Sentry init errors; `getFeedback()` returns null if integration failed to load |
| Linear issues not created | Verify the Linear integration is enabled in Sentry and the Alert Rule filter matches `issue.category:feedback` |
| Replay not linked | Replay is sampled at 10% for sessions, 100% on error. Not all feedback submissions will have a replay |
| Name/email not pre-populated | Verify `SentryUserContext` is mounted and `Sentry.setUser()` is being called (check with Sentry debug mode) |
