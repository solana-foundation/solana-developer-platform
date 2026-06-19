output "service_uri" {
  value = google_cloud_run_v2_service.kora.uri
}

output "runtime_service_account_email" {
  value = google_service_account.runtime.email
}

output "deployer_service_account_email" {
  value = google_service_account.deployer.email
}

output "kms_key_version_name" {
  description = "Set as KORA_GCP_KMS_KEY_NAME in Doppler. Derive KORA_GCP_KMS_PUBLIC_KEY (base58) from: gcloud kms keys versions get-public-key 1 --key fee-payer --keyring <name_prefix> --location <kms_location>."
  value       = "${google_kms_crypto_key.fee_payer.id}/cryptoKeyVersions/1"
}

output "redis_url" {
  description = "host:port only. Redis has AUTH + TLS, so KORA_REDIS_URL must be rediss://:<AUTH_TOKEN>@host:port (PRO-1319)."
  value       = "redis://${google_redis_instance.kora.host}:${google_redis_instance.kora.port}"
}

output "artifact_registry_repo" {
  description = "Push the Kora image here."
  value       = "${var.region}-docker.pkg.dev/${var.project_id}/${google_artifact_registry_repository.kora.repository_id}"
}

output "wif_provider" {
  description = "For google-github-actions/auth (workload_identity_provider)."
  value       = google_iam_workload_identity_pool_provider.github.name
}
