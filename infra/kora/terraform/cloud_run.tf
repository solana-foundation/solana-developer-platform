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
      # Pinned upstream Kora image, mirrored into this project's Artifact Registry (Cloud Run cannot
      # pull ghcr.io). The live tag is bumped + deployed by the pipeline (see deploy-kora.yml); this is
      # the bootstrap value and is ignored thereafter (ignore_changes below).
      image = var.kora_image

      # The official Kora image entrypoint is just `kora` (EXPOSE 8080); we supply the start command.
      # Config + signers are mounted from Secret Manager at the paths below.
      args = [
        "kora",
        "--config",
        "/app/config/kora.toml",
        "rpc",
        "start",
        "--signers-config",
        "/app/signers/signers.toml",
        "--port",
        "8080",
      ]

      ports {
        container_port = 8080
      }

      resources {
        limits = {
          cpu    = var.cpu
          memory = var.memory
        }
      }

      # kora.<env>.toml mounted from Secret Manager.
      volume_mounts {
        name       = "kora-config"
        mount_path = "/app/config"
      }

      # signers.<env>.toml mounted from Secret Manager.
      volume_mounts {
        name       = "kora-signers"
        mount_path = "/app/signers"
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

    volumes {
      name = "kora-config"
      secret {
        secret = google_secret_manager_secret.kora_config.secret_id
        items {
          version = "latest"
          path    = "kora.toml"
        }
      }
    }

    volumes {
      name = "kora-signers"
      secret {
        secret = google_secret_manager_secret.kora_signers.secret_id
        items {
          version = "latest"
          path    = "signers.toml"
        }
      }
    }
  }

  # Image + env are owned by the deploy pipeline (doppler run -- gcloud run services update): the
  # pipeline mirrors a pinned ghcr tag into AR and deploys it, and sets KORA_<ENV>_* env from Doppler.
  # Config files are delivered via the Secret Manager volumes above (Terraform-owned).
  lifecycle {
    ignore_changes = [
      template[0].containers[0].image,
      template[0].containers[0].env,
      client,
      client_version,
    ]
  }

  depends_on = [
    google_kms_crypto_key_iam_member.runtime_signer,
    google_secret_manager_secret_iam_member.runtime_config_accessor,
    google_secret_manager_secret_iam_member.runtime_signers_accessor,
  ]
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
