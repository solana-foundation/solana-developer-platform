# User feedback

The dashboard initializes Sentry in the browser, server, and edge runtime when
`NEXT_PUBLIC_SENTRY_DSN` is set. Development and
`NEXT_PUBLIC_DISABLE_SENTRY=1` turn it off. Sentry receives request and
rendering errors, sampled traces and replays, and the attachments of feedback
sent from the dashboard. These SDK signals are separate from the Grafana log
inventory.

## Feedback entry points

- **Send feedback** in the sidebar user menu opens the feedback screen
  (`/dashboard/{projectId}/feedback`). It asks what the feedback is about
  (something's broken, an idea, a question), what the user would change (up to
  5,000 characters), and up to five screenshots or PDFs, 10 MB each. The link
  carries the page the user was on (`?from=`, dashboard paths only), which the
  email names under **Page**; opened any other way, the email names no page.
  A retry of unchanged feedback reuses the first try's Sentry event.
- The global error page captures the exception and opens Sentry's report
  dialog with that event ID when the user selects **Report this issue**.

The client does not register Sentry's feedback widget; the screen is the only
feedback form.

## Delivery

The words go by email. The screen calls
`POST /v1/organizations/{orgId}/feedback`, and the API sends one email to
`SDP_OPERATOR_EMAIL` through Iterable (`ITERABLE_API_URL`, `ITERABLE_API_KEY`,
`ITERABLE_TRANSACTIONAL_CAMPAIGN_ID`), replying to the sender's account email.
Nothing is stored. Without that configuration the API answers 503 and the
screen says SDP isn't answering.

Sentry is optional. With a Sentry client the screen first records the feedback
with `Sentry.sendFeedback`, tagged `feedback_category`, with the session's
replay and the attachments, and waits for Sentry to accept it; the email then
carries that event ID under **Sentry event**. If Sentry refuses an upload with
files, nothing is sent and the screen asks the user to send again or remove the
files; without files the email goes anyway, naming no event. Without a Sentry
client the screen hides **Attach files** and still sends the email.

## Identity and privacy

`SentryUserContext` sends the Clerk user ID and an organization ID tag. It does
not attach the user's name or email. The feedback screen asks for no name or
email; the email to SDP names the sender from their account so the team can
reply. `sendDefaultPii` is false, and shared Sentry hooks scrub event content.
Replay masks text and blocks media. A user can still choose to attach a
screenshot or enter identifying text in feedback, so review the submitted
content when handling it.

## Troubleshooting

| Symptom                                         | Check                                                                                                        |
| ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| The screen says SDP isn't answering             | Confirm the deployment's Iterable keys and `SDP_OPERATOR_EMAIL` are set (an address, not `placeholder`).     |
| No email reaches the team                       | Check Iterable's send log for the transactional campaign and the `sdp_api_request_timing` line for the POST. |
| The email says files are in Sentry, none appear | Check the Sentry event ID in the email against the `sdp-web` project's user feedback.                        |
| Attach files is missing                         | Sentry is off for the deployment (no DSN, development, or `NEXT_PUBLIC_DISABLE_SENTRY=1`).                   |
| Replay is absent                                | Production session replay is sampled at 10%; an error can trigger replay at 100%.                            |
