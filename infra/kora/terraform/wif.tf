# Pool + provider + deployer SA binding are created as a unit, gated by var.create_wif.
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
