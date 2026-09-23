# Pinned ids of the resources the first (admin) deploy creates (variables.tf, arns.tf).
#
# Decision: a check, not a validation. The bootstrap must apply before anything is deployed, so
# empty ids are valid; Terraform then warns on every plan and apply until they are set, and the
# CI roles simply have no rights on those resources.

check "deployed_ids_are_pinned" {
  assert {
    condition = alltrue([
      for id in [var.http_api_id, var.distribution_id, var.origin_access_control_id, var.response_headers_policy_id, var.certificate_id] : id != ""
    ])
    error_message = "Some deployed resource ids are empty, so CI cannot update those resources yet. After the first deploy, fill infra/terraform/bootstrap/deployed-ids.auto.tfvars (docs/deploy.md) and apply the bootstrap again."
  }
}
