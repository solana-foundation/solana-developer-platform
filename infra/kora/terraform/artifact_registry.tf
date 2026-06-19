resource "google_artifact_registry_repository" "kora" {
  repository_id = local.name_prefix
  location      = var.region
  format        = "DOCKER"
  labels        = local.labels
}

resource "google_artifact_registry_repository_iam_member" "deployer_writer" {
  repository = google_artifact_registry_repository.kora.repository_id
  location   = google_artifact_registry_repository.kora.location
  role       = "roles/artifactregistry.writer"
  member     = "serviceAccount:${google_service_account.deployer.email}"
}
