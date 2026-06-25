data "google_compute_network" "vpc" {
  name = var.vpc_network
}

resource "google_vpc_access_connector" "kora" {
  name          = local.name_prefix
  region        = var.region
  network       = var.vpc_network
  ip_cidr_range = var.connector_cidr
  min_instances = 2
  max_instances = 3
}

resource "google_redis_instance" "kora" {
  name               = local.name_prefix
  tier               = var.redis_tier
  memory_size_gb     = var.redis_memory_gb
  region             = var.region
  authorized_network = data.google_compute_network.vpc.id
  connect_mode       = "DIRECT_PEERING"
  redis_version      = "REDIS_7_2"
  labels             = local.labels

  auth_enabled            = true
  transit_encryption_mode = "DISABLED"
}
