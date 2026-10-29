#!/usr/bin/env bash
# First-pass drift scan of one SDP module against the current architecture
# (docs/decisions/0005-release-channels.md, 0007-cluster-scope-ambient.md,
# 0007-money-admission.md, 0009-idempotency-keys.md, 0011-cron-definitions.md,
# docs/contributing/code-standards.md) and the 2026 refresh design.
#
# It prints leads, not verdicts. Comment lines are skipped, but a hit can still
# be a test helper or an allowed exception, so read every one in source before
# it goes in the ledger. A clean section only means these patterns found
# nothing: the manual checks in references/ still apply.
#
# Usage, from anywhere inside an SDP checkout (bash 4.3+, Node 24+). The script
# can live anywhere (the repo's .agents/skills or ~/.claude/skills): it scans
# the checkout of the current directory.
#   <skill-dir>/scripts/scan-module.sh <module> [extra-path ...]
#   MAX_HITS=200 <skill-dir>/scripts/scan-module.sh dvp > /tmp/dvp-scan.txt
#
# <module> is the kebab-case slug the module's directories use: dvp, issuance,
# private-channels, helius-rings, compliance, earn. Extra paths add files the
# naming convention misses (a shared job, a provider package, a shared page).
set -uo pipefail

if [ "${BASH_VERSINFO[0]}" -lt 4 ] || { [ "${BASH_VERSINFO[0]}" -eq 4 ] && [ "${BASH_VERSINFO[1]}" -lt 3 ]; }; then
  echo "scan-module.sh needs bash 4.3+ (macOS ships 3.2: brew install bash, then run it with that bash)" >&2
  exit 2
fi

MODULE="${1:?usage: scan-module.sh <module> [extra-path ...]}"
shift
MAX_HITS="${MAX_HITS:-10}"
ROOT="$(git rev-parse --show-toplevel)" || exit 1
cd "$ROOT" || exit 1

API=apps/sdp-api/src
WEB=apps/sdp-web/src
DASH="$WEB/app/dashboard/[projectId]"
SNAKE="${MODULE//-/_}"
UPPER="${SNAKE^^}"
# Pure bash: BSD sed has no \U, so a sed conversion breaks on macOS.
IFS=- read -ra words <<<"$MODULE"
CAMEL="${words[0]}"
for w in "${words[@]:1}"; do CAMEL+="${w^}"; done
# Tables use the singular too (private_channels, private_channel_instances).
TABLE_PREFIX="${SNAKE%s}"
INFRA="${SDP_INFRA_DIR:-$HOME/sdp-infra}"

add_existing() { # array-name path...
  local -n into="$1"
  shift
  local p
  for p in "$@"; do [ -e "$p" ] && into+=("$p"); done
}

dedupe() { # array-name
  local -n list="$1"
  local -A seen=()
  local kept=() p
  for p in "${list[@]}"; do
    [ -n "${seen[$p]:-}" ] && continue
    seen[$p]=1
    kept+=("$p")
  done
  list=("${kept[@]}")
}

api_paths=()
pkg_paths=()
web_paths=()
add_existing api_paths "$API/routes/$MODULE" "$API/routes/$MODULE.ts" "$API/routes/internal-$MODULE" \
  "$API/services/$MODULE" "$API/lib/$MODULE"
for f in "$API"/cron/"$MODULE"-*.ts "$API"/services/jobs/*"$MODULE"*.ts "$API"/db/repositories/"$MODULE"*.ts; do
  case "$f" in *.test.ts) continue ;; esac
  add_existing api_paths "$f"
done
add_existing pkg_paths "packages/sdp-$MODULE/src"
while IFS= read -r d; do web_paths+=("$d"); done < <(find "$WEB/app" -type d -name "$MODULE" -not -path "*/node_modules/*" 2>/dev/null)

# Modules whose files do not all follow the slug.
case "$MODULE" in
  earn)
    add_existing web_paths "$DASH/markets/treasury-solutions" "$DASH/markets/embedded-yield"
    for p in kamino veda jupiter-lend hastra ondo wisdomtree; do add_existing pkg_paths "packages/sdp-$p/src"; done
    ;;
  issuance) add_existing api_paths "$API/routes/asset-profiles" ;;
  private-channels)
    add_existing api_paths "$API/cron/pending-withdrawals.ts" "$API/services/jobs/track-pending-withdrawals.ts"
    add_existing pkg_paths packages/sdp-spc-escrow/src packages/sdp-spc-withdraw/src
    ;;
  helius-rings)
    add_existing api_paths "$API/cron/rings-indexing.ts"
    add_existing pkg_paths packages/sdp-helius-rings-sdk/src
    ;;
esac
for p in "$@"; do
  case "$p" in
    "$WEB"*) add_existing web_paths "$p" ;;
    packages/*) add_existing pkg_paths "$p" ;;
    *) add_existing api_paths "$p" ;;
  esac
done
dedupe api_paths
dedupe pkg_paths
dedupe web_paths

if [ "${#api_paths[@]}" -eq 0 ] && [ "${#pkg_paths[@]}" -eq 0 ] && [ "${#web_paths[@]}" -eq 0 ]; then
  echo "No files found for '$MODULE'. Use the slug its directories use (dvp, issuance," >&2
  echo "private-channels, helius-rings, compliance, earn) or pass the module's paths." >&2
  exit 2
fi

server_paths=("${api_paths[@]}" "${pkg_paths[@]}")

# grep over source: tests, fixtures, generated code and comment lines left out.
search() { # pattern path...
  local pat="$1"
  shift
  [ $# -eq 0 ] && return 0
  grep -rHnE --include='*.ts' --include='*.tsx' --include='*.mjs' "$pat" "$@" 2>/dev/null |
    grep -vE '\.test\.tsx?:|\.spec\.tsx?:|\.fixtures?\.tsx?:|/test/|/__tests__/|/fixtures/|/testing/|/generated/' |
    grep -vE '^[^:]+:[0-9]+:[[:space:]]*(//|\*|/\*)' || true
}

# A drift lead: prints the count and the first hits.
lead() { # id title pattern path...
  local id="$1" title="$2" pat="$3"
  shift 3
  local out n
  out="$(search "$pat" "$@")"
  n="$(printf '%s' "$out" | grep -c . || true)"
  printf '  %-4s %-66s %5s\n' "$id" "$title" "$n"
  if [ "$n" -gt 0 ]; then
    printf '%s\n' "$out" | head -n "$MAX_HITS" | cut -c1-220 | sed 's/^/         /'
  fi
}

# A conformance signal: the shared mechanism in use. Zero is the lead here.
signal() { # id title pattern path...
  local id="$1" title="$2" pat="$3"
  shift 3
  local n
  n="$(search "$pat" "$@" | grep -c . || true)"
  printf '  %-4s %-66s %5s\n' "$id" "+ $title" "$n"
}

note() { printf '  %-4s %s\n' "$1" "$2"; }
section() { printf '\n== %s\n' "$1"; }

echo "Module: $MODULE   HEAD $(git rev-parse --short HEAD) on $(git rev-parse --abbrev-ref HEAD), origin/main $(git rev-parse --short origin/main 2>/dev/null || echo unknown)"
echo "API:      ${api_paths[*]:-none}"
echo "Packages: ${pkg_paths[*]:-none}"
echo "Web:      ${web_paths[*]:-none}"
case "$MODULE" in
  dvp | earn) echo "Markets sub-module: shared Markets files (markets-landing.tsx, markets-route-skeletons.tsx, getMarketsRoutePageConfig, DashboardMarkets.* copy) are not scanned; pass them as extra paths." ;;
esac
echo "Legend: a count is a lead to read in source; '+' rows count the shared mechanism in use (zero is the lead)."

section "Release channel and gates (architecture.md A1)"
grep -nE "^\s+$SNAKE: \"" packages/sdp-types/src/release-channels.ts | sed 's/^/  maturity: /' || echo "  maturity: no SDP_MODULE_MATURITY entry for $SNAKE"
mount="$(grep -nE "\"/$MODULE(/\*)?\"" "$API/app.ts" || true)"
printf '%s\n' "${mount:-no /v1/$MODULE mount in app.ts}" | sed 's/^/  mount: /'
if printf '%s' "$mount" | grep -q "requireModule("; then
  note A1 "mounted behind requireModule: yes"
else
  note A1 "mounted behind requireModule: NO (a module flag gate folds the channel in)"
fi
lead A1 "module-owned feature gate" "function require[A-Za-z]*Feature" "${api_paths[@]}"
flag_keys=""
for fn in $(search "is[A-Z][A-Za-z]*Enabled\(" "${api_paths[@]}" | grep -oE "is[A-Z][A-Za-z]*Enabled" | sort -u); do
  keys="$(awk "/export function $fn\\(/,/^}/" "$API/lib/feature-flags.ts" | grep -oE "[A-Z][A-Z0-9_]*_ENABLED" | sort -u | tr '\n' ' ')"
  [ -n "$keys" ] && note A1 "kill switch: $fn reads $keys" && flag_keys+="$keys"
done
web_flag="$(grep -nE "const ($CAMEL|$SNAKE) = flag" "$WEB/flags/definitions.ts" | head -1 || true)"
[ -z "$web_flag" ] && web_flag="none named $CAMEL in web/flags/definitions.ts (check the area flag)"
note A1 "dashboard flag: $web_flag"

section "Cluster scope and RPC door (A2-A4)"
lead A2 "process-default RPC, env URL or legacy resolver" \
  "\bcreateRpc\(|createSolanaRpc|createDefaultRpcTransport|createSolanaRpcFromTransport|resolveClusterRpcUrls?\(|SOLANA_NETWORK|SOLANA_RPC_URL\b|SOLANA_(MAINNET|DEVNET)_RPC_URL|resolveDefaultCluster|getSolanaConfig|defaultFeePaymentCluster" \
  "${server_paths[@]}"
lead A2 "cluster or environment threaded, not read from the scope" \
  "resolveSdpEnvironment\(|CLUSTER_BY_SDP_ENVIRONMENT|\brpcUrl\??:|\.ENVIRONMENT\b" "${api_paths[@]}"
lead A2 "scope opened outside an entry point" "runInClusterScope\(|runInEnvironmentClusterScope\(" "${server_paths[@]}"
signal A2 "createClusterRpc() / currentClusterScope() calls" "createClusterRpc\(|createClusterHistoryRpc\(|currentClusterScope\(" "${server_paths[@]}"
lead A3 "own client, transport or raw JSON-RPC" \
  "new Connection\(|from \"@solana/web3\.js\"|jsonrpc: ?[\"']2\.0|createJsonRpcApi|earnClusterEndpointUrls|proveEarnClusterEndpoint" \
  "${server_paths[@]}"
lead A3 "signature history reads (ask the RPC owner: history pool or not)" "getSignaturesForAddress|\.getTransaction\(" "${server_paths[@]}"
lead A4 "scans, clock and height reads (each must be needed, after rows)" \
  "getProgramAccounts|\.getBlockTime\(|\.getSlot\(|\.getBlockHeight\(|\.getGenesisHash\(" "${server_paths[@]}"
budget_tests="$(find "${server_paths[@]}" -name '*rpc-budget*' 2>/dev/null | grep -c . || true)"
printf '  %-4s %-66s %5s\n' A4 "+ RPC budget tests pinning request counts" "$budget_tests"

section "Crons (A5)"
found_cron=0
for f in "${api_paths[@]}"; do
  case "$f" in "$API"/cron/*.ts) ;; *) continue ;; esac
  found_cron=1
  scope="$(grep -E '^[[:space:]]+scope: "(cluster|global)"' "$f" | grep -oE '"(cluster|global)"' | head -1)"
  nnote="$(grep -cE '^// NOTE' "$f" || true)"
  jobs="$(grep -oE 'from "@/services/[^"]+"' "$f" | sed -E 's#from "@/services/##; s#"##' | tr '\n' ' ')"
  printf '  A5   %-34s %-10s NOTE:%s  runs: %s\n' "${f#"$API"/}" "${scope:-none}" "$nnote" "${jobs:-inline}"
done
[ "$found_cron" -eq 0 ] && note A5 "no cron definitions under cron/ for this module (check services/jobs callers)"
note A5 "manual: a global cron whose job reaches chain RPC flips to cluster; a height or status read comes after the row query"

section "Auth, idempotency, money (A6-A9)"
lead A6 "anonymous or optional-auth paths" "optionalAuth|optionalClerkAuth|requireActionWhenAuthenticated|publicRoute\(" "${api_paths[@]}"
signal A6 "requireAction() declarations" "requireAction\(" "${api_paths[@]}"
lead A7 "requestGate or a direct Idempotency-Key read" \
  "requestGate|header\(IDEMPOTENCY_KEY_HEADER\)|header\([\"'][Ii]dempotency-[Kk]ey[\"']\)" "${api_paths[@]}"
lead A7 "module-owned key columns or replay tables" "idempotency_key|request_id" "${api_paths[@]}"
lead A7 "key reuse answered 409 (the shared step answers 422)" "conflict\([^)]*([Ii]dempotency|same key|reused)" "${api_paths[@]}"
signal A7 "authorize / idempotent / replayFromRecord steps" "\bauthorize(None)?\(|\bidempotent\(|replayFromRecord\(" "${api_paths[@]}"
lead A7 "dashboard mutation sent with no key (bare request init)" "\{ *method: [\"'](POST|PUT|PATCH|DELETE)[\"'] *\}" "${web_paths[@]}"
lead A8 "sponsor or send outside the waist" \
  "signAsFeePayer|signAndSendTransaction|\.sendTransaction\(|createKoraAdapter|KoraClient|KORA_[A-Z_]*URL" "${server_paths[@]}"
signal A8 "waists: sponsored submit, sponsor, custody signer, admission" \
  "submitSponsoredTransaction|createSponsorshipFeePayment|createOrgSignerForCustodyWallet|assertMoneyStartAdmitted|MOVEMENTS\." "${api_paths[@]}"
signal A8 "audit ledger writes" "record[A-Za-z]*Audit\(|createAuditService|auditService\." "${api_paths[@]}"
lead A9 "upstream failure mapped to 400, or cast/unparsed body" \
  "badRequest\([^)]*(upstream|unavailable|returned|could not be read)|as [A-Z][A-Za-z]*(Response|Body|Payload)\b|JSON\.parse\(" "${server_paths[@]}"
lead A9 "catch without the error bound (check for a swallowed failure)" "catch *\{|\.catch\(\(\) *=>" "${server_paths[@]}"
signal A9 "vendor-call instrumentation (n/a with no third-party API)" "logVendorCallFailure|instrumentVendorPort|withVendorCall" "${server_paths[@]}"

section "Data and config (A10-A12)"
lead A10 "status literals in SQL or local sets" "IN \('|new Set\(\[ *\"|=== \"[a-z_]+\" \|\|" "${api_paths[@]}"
lead A10 "hard deletes" "DELETE FROM|\.delete\(\)\.|deleteFrom\(" "${api_paths[@]}"
nullable=""
tables=""
for m in "$API"/db/migrations/postgres/*.sql; do
  grep -qiE "CREATE TABLE (IF NOT EXISTS )?\"?$TABLE_PREFIX" "$m" || continue
  tables+="$(grep -oiE "CREATE TABLE (IF NOT EXISTS )?\"?$TABLE_PREFIX[a-z0-9_]*" "$m" | awk '{print $NF}' | tr -d '"' | tr '\n' ' ')"
  hit="$(grep -nE '^\s*project_id\b' "$m" | grep -vE 'NOT NULL|PRIMARY KEY' || true)"
  [ -n "$hit" ] && nullable+="${m#"$API"/}: $hit"$'\n'
done
n="$(printf '%s' "$nullable" | grep -c . || true)"
printf '  %-4s %-66s %5s\n' A10 "nullable project_id in $SNAKE CREATE TABLEs (check later ALTERs)" "$n"
[ "$n" -gt 0 ] && printf '%s' "$nullable" | head -n "$MAX_HITS" | cut -c1-200 | sed 's/^/         /'
missing=""
while IFS= read -r key; do
  [ -z "$key" ] && continue
  where=""
  grep -q "\b$key\b" "$API/types/env.d.ts" || where+=" env.d.ts"
  grep -q "\b$key\b" scripts/secret-keys.mjs || where+=" secret-keys.mjs"
  grep -q "\"$key\"" turbo.json || where+=" turbo.json"
  [ -n "$where" ] && missing+="$key missing from:$where"$'\n'
done < <(search "(c\.env|\benv|process\.env)\.[A-Z][A-Z0-9_]{2,}" "${server_paths[@]}" | grep -oE "(c\.env|\benv|process\.env)\.[A-Z][A-Z0-9_]{2,}" | sed -E 's/.*\.//' | sort -u)
n="$(printf '%s' "$missing" | grep -c . || true)"
printf '  %-4s %-66s %5s\n' A11 "env keys not in all of env.d.ts, secret-keys.mjs, turbo.json" "$n"
[ "$n" -gt 0 ] && printf '%s' "$missing" | head -n "$MAX_HITS" | sed 's/^/         /'
lead A12 "type escapes" "as any\b|: any\b|<any>|@ts-ignore|@ts-expect-error|as unknown as" "${server_paths[@]}" "${web_paths[@]}"
lead A12 "hard-coded base58 addresses (mints, program ids)" "[\"'][1-9A-HJ-NP-Za-km-z]{32,44}[\"']" "${server_paths[@]}" "${web_paths[@]}"

section "Reconcilers, tenancy, programs (A13-A15)"
signal A13 "compare-and-set status writes" "expectedStatus|AND status = \?|WHERE status = \?" "${api_paths[@]}"
note A13 "manual: every observed status has a terminal rule; claims release by proven expiry; 'not found' is not terminal"
# Forced either by name or through a loop over a table list (0081 does both).
mapfile -t rls_files < <(grep -liE "FORCE ROW LEVEL SECURITY" "$API"/db/migrations/postgres/*.sql)
no_rls=""
for t in $tables; do
  grep -qE "\b$t\b" "${rls_files[@]}" || no_rls+="$t "
done
note A14 "tables created: ${tables:-none found}"
note A14 "without FORCE ROW LEVEL SECURITY: ${no_rls:-none}"
note A15 "manual: each on-chain program the module calls is deployed, verified and IDL-published on every cluster its projects reach"

section "Refresh design (redesign.md B1-B9)"
if [ "${#web_paths[@]}" -eq 0 ]; then
  note B1 "no dashboard directory named $MODULE (pass its path as an extra argument)"
else
  pages="$(find "${web_paths[@]}" -name page.tsx 2>/dev/null | sort -u)"
  urls="$(printf '%s\n' "$pages" | sed -E "s#^$WEB/app##; s#/\[projectId\]##; s#/\([^/]+\)##g; s#/page\.tsx\$##; s#\[[^]]+\]#x#g")"
  printf '%s\n' "$urls" | grep . | node --no-warnings --input-type=module -e '
    const { themeScopeForPath } = await import(process.argv[1]);
    const lines = (await new Response(process.stdin).text()).split("\n").filter(Boolean);
    for (const url of lines) console.log(`  B1   ${(themeScopeForPath(url) ?? "BASE").padEnd(8)} ${url}`);
  ' "$ROOT/$WEB/lib/theme-scope-routes.ts" 2>/dev/null || note B1 "could not evaluate theme-scope-routes.ts (Node 24+ runs .ts natively)"
fi
lead B2 "header config lines naming the module" "$MODULE|$SNAKE|$CAMEL" "$WEB/components/dashboard-header.tsx"
lead B3 "legacy layout: fixed widths, px type, lifts, ad hoc lists" \
  "max-w-\[[0-9.]+rem\]|minWidth|min-w-\[[0-9.]+rem\]|text-\[[0-9]+px\]|hover:-translate|hover:shadow|shadow-(md|lg|xl)|bg-white text-black|uppercase tracking|<dl\b|max-w-(4|5|6|7)xl" \
  "${web_paths[@]}"
lead B3 "Card-wrapped sections" "<Card\b|CardContent|CardHeader" "${web_paths[@]}"
lead B3 "design-system imports the refresh replaces" "from \"@solana/design-system[^\"]*\"" "${web_paths[@]}"
signal B3 "refresh-only primitives in use" \
  "refresh-record|ui/action-tile|@sdp/ui/(detail-list|status-text|callout)|refresh:" "${web_paths[@]}"
lead B4 "hand-rolled overlays or steppers" "role=\"dialog\"|createPortal\(|fixed inset-0|\bStepper\b" "${web_paths[@]}"
signal B4 "@sdp/ui modal, wizard progress (or WizardFrame), detail list" \
  "@sdp/ui/(modal|wizard-step-progress|detail-list)|WizardFrame" "${web_paths[@]}"
lead B5 "legacy design-switch remnants" "DesignSwitch|withLegacyDesign|useNewDesign|\.redesign\b" "${web_paths[@]}"
note B6 "copy: run pnpm --filter sdp-web check:i18n; check promises in copy against the API"
playground="$(grep -nE "type PlaygroundModule =" apps/sdp-api/scripts/generate-playground-catalog.ts || true)"
if printf '%s' "$playground" | grep -qE "\"($SNAKE|$MODULE)\""; then
  note B8 "API playground family: yes"
else
  note B8 "API playground family: no (${playground#*:})"
fi
sections=""
for p in "${web_paths[@]}"; do
  case "$p" in "$DASH/"*) ;; *) continue ;; esac
  rest="${p#"$DASH/"}"
  s="${rest%%/*}"
  case " $sections " in *" $s "*) continue ;; esac
  sections+="$s "
  row="$(grep -E "^\| *$s *\|" docs/testing/ui-flow-matrix.md | head -1 || true)"
  [ -z "$row" ] && row="none (check:ui-flow-coverage fails)"
  note B9 "ui-flow-matrix row for section $s: $row"
done

section "Dashboard data (dashboard-data.md C1-C4)"
lead C1 "refreshInterval passed a named value (see web AGENTS.md)" "refreshInterval: *[A-Za-z_][A-Za-z0-9_.]*[,}]" "${web_paths[@]}"
lead C1 "numeric refreshInterval (fine only for a poll that never stops)" "refreshInterval: *[0-9]" "${web_paths[@]}"
lead C1 "polling outside SWR (timers, router.refresh)" "setInterval\(|router\.refresh\(" "${web_paths[@]}"
signal C1 "useCadencedSWR" "useCadencedSWR\(" "${web_paths[@]}"
lead C2 "inline SWR keys (use the colocated query-key factory)" "useSWR(Mutation|Infinite)?(<[^>]*>)?\( *[\"'\`\[]" "${web_paths[@]}"
lead C3 "focus revalidation left on" "revalidateOnFocus: *true" "${web_paths[@]}"

section "Public surface and docs (surfaces.md D1-D4)"
openapi="$(ls "$API/openapi/paths/$MODULE.ts" "$API/openapi/paths/$SNAKE.ts" 2>/dev/null | sort -u | tr '\n' ' ' || true)"
note D1 "internal OpenAPI paths file: ${openapi:-none}"
if awk '/const PUBLIC_OPENAPI_TAGS/,/\];/' "$API/openapi/spec.ts" | grep -qE "OPENAPI_TAG\.$UPPER\b"; then
  note D1 "public OpenAPI: OPENAPI_TAG.$UPPER is in PUBLIC_OPENAPI_TAGS"
else
  note D1 "public OpenAPI: OPENAPI_TAG.$UPPER is not in PUBLIC_OPENAPI_TAGS (held by omission, or no tag)"
fi
docs="$(grep -rlE "^module: ($SNAKE|$MODULE)\s*$" apps/sdp-docs/content 2>/dev/null | sort || true)"
note D2 "docs pages with module: $SNAKE frontmatter: $(printf '%s' "$docs" | grep -c . || true)"
lead D3 "fixed API hosts in module code" "api(-preview|-dev)?\.solana\.com" "${web_paths[@]}" "${server_paths[@]}"

section "sdp-infra (surfaces.md E1-E3)"
if git -C "$INFRA" rev-parse --verify -q origin/main >/dev/null 2>&1; then
  echo "  sdp-infra origin/main: $(git -C "$INFRA" log -1 --format='%h %cs' origin/main) (git fetch first if older than today)"
  flag_re="${SNAKE}_enabled"
  for k in $flag_keys; do flag_re+="|${k,,}"; done
  git -C "$INFRA" grep -n -iE "$flag_re|release_channel" origin/main -- 'terraform/envs/*/terraform.tfvars' 2>/dev/null |
    sed 's/^origin\/main:/  E1   /' | head -n 12
  rules="$(git -C "$INFRA" grep -l -iE "$MODULE|$SNAKE" origin/main -- 'kora/alert-rules' 'docs/runbooks' 'observability' 2>/dev/null | sed 's/^origin\/main://' || true)"
  note E2 "alert rules, runbooks and dashboards naming the module: $(printf '%s' "$rules" | grep -c . || true)"
  printf '%s\n' "$rules" | head -n "$MAX_HITS" | grep . | sed 's/^/         /'
else
  note E1 "sdp-infra not found at $INFRA (set SDP_INFRA_DIR); check E1-E3 by hand"
fi

# Leads are output, not failures: a finished scan exits 0 whatever it found.
exit 0
