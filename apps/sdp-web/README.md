# SDP Web

The Solana Developer Platform dashboard and landing site. A Next.js application providing the web UI for API key management, wallet creation, transaction monitoring, and project administration.

## What is SDP Web?

SDP Web is a Next.js application with two main surfaces:

### Public Surface
- **Landing page** (`/`) — Product overview and marketing
- **Sign-up / Sign-in** (`/sign-up`, `/sign-in`) — Clerk authentication
- **Allowlist form** (`/allowlist`) — Request access form
- **Member invite** (`/members`) — Token-gated invite acceptance

### Internal Surface (Authenticated Dashboard)
- **Dashboard** (`/dashboard/*`) — Requires Clerk authentication
  - API key management
  - Wallet creation and management
  - Transaction history and monitoring
  - Project settings
  - Team member management

## Local Development

### Prerequisites

- **Node.js 20+**
- **pnpm 10.15.1+**
- **Clerk account** (free tier) — required for authentication
- **SDP API running** — the dashboard proxies to `sdp-api` via BFF routes

### Setup

1. **Install dependencies:**
   ```bash
   pnpm install
   ```

2. **Configure environment variables:**

   **Option A: Using Doppler (team members)**
   ```bash
   doppler login
   pnpm dev
   ```

   **Option B: Using local `.env.local` (external contributors)**
   ```bash
   cp apps/sdp-web/.env.local.example apps/sdp-web/.env.local
   # Edit .env.local with your values (see below)
   pnpm dev
   ```

3. **Start the dev server:**
   ```bash
   # From repo root (uses Turborepo)
   pnpm dev

   # Or from apps/sdp-web directory
   pnpm dev:web
   ```

   The web app will be available at `http://localhost:3000`

### Required Environment Variables

Create `apps/sdp-web/.env.local`:

```bash
# Clerk authentication (required)
NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY=pk_test_...
CLERK_SECRET_KEY=sk_test_...

# SDP API endpoint (required)
NEXT_PUBLIC_SDP_API_BASE_URL=http://127.0.0.1:8787
```

### Optional Environment Variables

```bash
# Error tracking
NEXT_PUBLIC_SENTRY_DSN=https://...
SENTRY_AUTH_TOKEN=...

# Analytics (if configured)
NEXT_PUBLIC_ANALYTICS_ID=...
```

See `apps/sdp-web/.env.local.example` for all available options.

## Architecture

### Tech Stack
- **Next.js 15** — React framework
- **TypeScript** — Type safety
- **Clerk** — Authentication & organization management
- **React Query** — Server state management
- **TanStack Router** — Client-side routing
- **Tailwind CSS** — Styling

### Project Structure

```
apps/sdp-web/
├── src/
│   └── app/               # Next.js App Router
│       ├── sign-in/       # Clerk sign-in page
│       ├── sign-up/       # Clerk sign-up page
│       ├── allowlist/     # Request access form
│       ├── members/       # Token-gated invite acceptance
│       ├── dashboard/     # Protected dashboard routes
│       └── api/           # Next.js API routes (BFF)
└── public/                # Static assets
```

### Backend-for-Frontend (BFF)

The dashboard does NOT call `sdp-api` directly. Instead, it uses internal API routes:

```
sdp-web routes         → sdp-api routes
/api/dashboard/* → /v1/*
```

This allows:
- Session-based auth (Clerk tokens)
- Server-side secret management
- CORS handling
- Request logging

## Running Tests

### E2E Tests (Playwright)

```bash
pnpm --filter sdp-web test:e2e
```

Requires:
- Clerk test instance configured
- SDP API running
- `.env.local` with test credentials

## Development Workflow

### Hot Reload

Changes to `app/`, `components/`, and `lib/` automatically reload in the browser.

### Adding a New Page

1. Create file in `app/dashboard/your-page/page.tsx`
2. Use Clerk's `useAuth()` hook for authentication
3. Proxy requests to SDP API via `/api/dashboard/*`

Example:

```typescript
// app/dashboard/users/page.tsx
import { useAuth } from "@clerk/nextjs";

export default function UsersPage() {
  const { isLoaded, isSignedIn } = useAuth();

  if (!isLoaded) return <div>Loading...</div>;
  if (!isSignedIn) return <div>Not authenticated</div>;

  // Fetch from BFF
  const response = await fetch("/api/dashboard/users", {
    headers: { Authorization: "Bearer <clerk-token>" }
  });

  // Render page
}
```

### Environment-Specific Configuration

The app detects environment via `process.env.NODE_ENV`:

```typescript
const apiUrl = process.env.NEXT_PUBLIC_SDP_API_BASE_URL || "http://localhost:8787";
```

## Deployment

### Vercel (Recommended)

```bash
# Connect repo to Vercel
vercel link
vercel deploy
```

Requires environment variables set in Vercel project settings:
- `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY`
- `CLERK_SECRET_KEY`
- `NEXT_PUBLIC_SDP_API_BASE_URL`
- `SENTRY_DSN` (optional)


## Troubleshooting

### "Clerk is not initialized"
- Ensure `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY` is set in `.env.local`
- Restart the dev server after changing env vars

### Dashboard returns 401/403
- Verify Clerk session is active (check Network tab for auth token)
- Check that `CLERK_SECRET_KEY` is valid
- Verify SDP API is running and reachable

### API calls return 502/503
- Ensure SDP API is running (`pnpm dev` from repo root)
- Check `NEXT_PUBLIC_SDP_API_BASE_URL` points to correct API instance
- Check SDP API logs for errors

## Contributing

- Follow the repo's TypeScript conventions (see `AGENTS.md`)
- Add tests for new pages and components
- Keep BFF routes thin — business logic goes in `sdp-api`
- Update styles using Tailwind classes, not custom CSS

For full contribution guidelines, see [`CONTRIBUTING.md`](../../CONTRIBUTING.md) (forthcoming).

## Support

- **Public docs**: https://platform.solana.com/docs
- **GitHub Issues**: https://github.com/solana-foundation/solana-developer-platform/issues
- **Slack**: Internal team channel (maintainers only)
