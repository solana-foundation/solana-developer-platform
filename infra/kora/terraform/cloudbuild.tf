data "google_project" "current" {}

resource "google_project_service" "cloudbuild" {
  service            = "cloudbuild.googleapis.com"
  disable_on_destroy = false
}

# Deployer (WIF/CI) can submit builds.
resource "google_project_iam_member" "deployer_cloudbuild" {
  project = var.project_id
  role    = "roles/cloudbuild.builds.editor"
  member  = "serviceAccount:${google_service_account.deployer.email}"
}

# The Cloud Build SA must push the built image to the AR repo.
# NOTE: confirm this project's active Cloud Build SA (legacy <number>@cloudbuild vs the Compute default
# SA) and adjust the member if needed. The deployer may also need storage.objectAdmin on the
# gs://<project>_cloudbuild staging bucket once it exists.
resource "google_artifact_registry_repository_iam_member" "cloudbuild_writer" {
  repository = google_artifact_registry_repository.kora.repository_id
  location   = google_artifact_registry_repository.kora.location
  role       = "roles/artifactregistry.writer"
  member     = "serviceAccount:${data.google_project.current.number}@cloudbuild.gserviceaccount.com"
}
