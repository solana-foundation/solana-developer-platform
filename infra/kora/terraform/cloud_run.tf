resource "google_cloud_run_v2_service" "kora" {
  name                = local.name_prefix
  location            = var.region
  ingress             = "INGRESS_TRAFFIC_ALL"
  labels              = local.labels
  deletion_protection = var.deletion_protection

  template {
    service_account = google_service_account.runtime.email

    scaling {
      min_instance_count = var.min_scale
      max_instance_count = var.max_scale
    }

    vpc_access {
      connector = google_vpc_access_connector.kora.id
      egress    = "PRIVATE_RANGES_ONLY"
    }

    containers {
      image = var.bootstrap_image

      ports {
        container_port = 8080
      }

      resources {
        limits = {
          cpu    = var.cpu
          memory = var.memory
        }
      }

      startup_probe {
        http_get {
          path = "/liveness"
          port = 8080
        }
        initial_delay_seconds = 5
        timeout_seconds       = 3
        period_seconds        = 10
        failure_threshold     = 6
      }
    }
  }

  # Image + env are owned by the deploy pipeline (doppler run -- gcloud run deploy); config is baked
  # into the image. No Secret Manager.
  lifecycle {
    ignore_changes = [
      template[0].containers[0].image,
      template[0].containers[0].env,
      client,
      client_version,
    ]
  }

  depends_on = [google_kms_crypto_key_iam_member.runtime_signer]
}

resource "google_cloud_run_v2_service_iam_member" "deployer_admin" {
  name     = google_cloud_run_v2_service.kora.name
  location = var.region
  role     = "roles/run.admin"
  member   = "serviceAccount:${google_service_account.deployer.email}"
}

resource "google_cloud_run_v2_service_iam_member" "public_invoker" {
  count    = var.allow_unauthenticated ? 1 : 0
  name     = google_cloud_run_v2_service.kora.name
  location = var.region
  role     = "roles/run.invoker"
  member   = "allUsers"
}
