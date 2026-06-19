# WIF is all-or-nothing via var.create_wif: the pool, provider, and the deployer SA's
# workloadIdentityUser binding share one count, so a `create_wif=true` apply creates the
# whole chain together (see the variable docs for the out-of-band caveat). Pool IDs are
# project-scoped, so the trading-prod `mainnet` workspace and the SDP `mainnet-sdp` workspace
# can each hold a `kora-mainnet` pool without colliding — as long as they target their own
# projects (trading-prod via `-var project_id=trading-prod-494016`).
resource "google_iam_workload_identity_pool" "github" {
  count                     = var.create_wif ? 1 : 0
  workload_identity_pool_id = local.name_prefix
  display_name              = "Kora ${var.env} GitHub OIDC"
}

resource "google_iam_workload_identity_pool_provider" "github" {
  count                              = var.create_wif ? 1 : 0
  workload_identity_pool_id          = google_iam_workload_identity_pool.github[0].workload_identity_pool_id
  workload_identity_pool_provider_id = "github"
  display_name                       = "GitHub Actions"

  attribute_mapping = {
    "google.subject"       = "assertion.sub"
    "attribute.repository" = "assertion.repository"
    "attribute.ref"        = "assertion.ref"
  }
  # Only the configured repo AND branch can mint a token — not every branch/workflow in the repo.
  attribute_condition = "assertion.repository == \"${var.github_repo}\" && assertion.ref == \"${var.github_ref}\""

  oidc {
    issuer_uri = "https://token.actions.githubusercontent.com"
  }
}

# GitHub Actions in github_repo may impersonate the deployer SA — keyless, no JSON key.
resource "google_service_account_iam_member" "deployer_wif" {
  count              = var.create_wif ? 1 : 0
  service_account_id = google_service_account.deployer.name
  role               = "roles/iam.workloadIdentityUser"
  member             = "principalSet://iam.googleapis.com/${google_iam_workload_identity_pool.github[0].name}/attribute.repository/${var.github_repo}"
}
