output "project_info" {
  value = {
    project     = var.project
    environment = var.environment
    region      = var.region
  }
}
