resource "google_service_account" "runtime" {
  account_id   = "${local.name_prefix}-runtime"
  display_name = "Kora ${var.env} — Cloud Run runtime"
}

resource "google_service_account" "deployer" {
  account_id   = "${local.name_prefix}-deployer"
  display_name = "Kora ${var.env} — CI deployer"
}

resource "google_service_account_iam_member" "deployer_actas_runtime" {
  service_account_id = google_service_account.runtime.name
  role               = "roles/iam.serviceAccountUser"
  member             = "serviceAccount:${google_service_account.deployer.email}"
}
