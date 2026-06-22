# Kora config delivery via Secret Manager.
#
# We deploy the official upstream Kora image (no config baked in). The non-secret config files
# (kora.<env>.toml + signers.<env>.toml) are stored as Secret Manager secrets and mounted into the
# Cloud Run container as secret volumes. Editing config = `terraform apply` (adds a new secret
# version) followed by a new revision so the running service picks it up.
#
# These two files are NOT secrets (no keys/tokens — secrets come from KORA_<ENV>_* env via Doppler);
# Secret Manager is used purely because Cloud Run secret volumes are the supported way to mount file
# content into a container we don't build.

locals {
  kora_config_path  = "${path.module}/../cloud-run/kora.${var.env}.toml"
  kora_signers_path = "${path.module}/../cloud-run/signers.${var.env}.toml"
}

resource "google_secret_manager_secret" "kora_config" {
  secret_id = "${local.name_prefix}-config"
  labels    = local.labels

  replication {
    auto {}
  }
}

resource "google_secret_manager_secret_version" "kora_config" {
  secret      = google_secret_manager_secret.kora_config.id
  secret_data = file(local.kora_config_path)
}

resource "google_secret_manager_secret" "kora_signers" {
  secret_id = "${local.name_prefix}-signers"
  labels    = local.labels

  replication {
    auto {}
  }
}

resource "google_secret_manager_secret_version" "kora_signers" {
  secret      = google_secret_manager_secret.kora_signers.id
  secret_data = file(local.kora_signers_path)
}

# The Cloud Run runtime SA must be able to read both config secrets to mount them.
resource "google_secret_manager_secret_iam_member" "runtime_config_accessor" {
  secret_id = google_secret_manager_secret.kora_config.id
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${google_service_account.runtime.email}"
}

resource "google_secret_manager_secret_iam_member" "runtime_signers_accessor" {
  secret_id = google_secret_manager_secret.kora_signers.id
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${google_service_account.runtime.email}"
}
