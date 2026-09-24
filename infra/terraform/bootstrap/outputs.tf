# Values an admin copies into GitHub (docs/deploy.md) and into infra/sam/samconfig.toml.

output "deploy_role_arn" {
  description = "GitHub repository variable AWS_DEPLOY_ROLE_ARN."
  value       = aws_iam_role.deploy.arn
}

output "plan_role_arn" {
  description = "GitHub repository variable AWS_PLAN_ROLE_ARN."
  value       = aws_iam_role.plan.arn
}

output "artifacts_bucket" {
  description = "SAM artifacts bucket (samconfig.toml s3_bucket)."
  value       = aws_s3_bucket.artifacts.bucket
}

output "permissions_boundary_arn" {
  description = "Boundary every CI-created role must carry (SAM parameter PermissionsBoundaryArn)."
  value       = aws_iam_policy.boundary.arn
}

output "unpinned_resource_ids" {
  description = "Deployed resource ids still empty; CI cannot update these resources until they are set."
  value = [
    for name, id in {
      http_api_id                = var.http_api_id
      distribution_id            = var.distribution_id
      api_distribution_id        = var.api_distribution_id
      origin_access_control_id   = var.origin_access_control_id
      response_headers_policy_id = var.response_headers_policy_id
      certificate_id             = var.certificate_id
    } : name if id == ""
  ]
}
