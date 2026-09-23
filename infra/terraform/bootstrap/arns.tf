# Every ARN the CI policies grant, built from names and pinned ids so policies are readable and
# testable without looking anything up. Names here must match infra/sam/template.yaml and
# infra/terraform/platform (the terraform tests and the SAM template test check both sides).

locals {
  account = var.aws_account_id
  region  = var.region

  boundary_policy_arn = "arn:aws:iam::${local.account}:policy/${local.name}-boundary"
  artifacts_bucket    = "${local.name}-artifacts-${local.account}"
  web_bucket          = "${local.name}-web-${local.account}"

  # The SAM stack and what it creates. Decision: exact names, not italy-planner-* wildcards, so
  # the deploy role cannot create a second function or role next to the ones in the template.
  stack_arn           = "arn:aws:cloudformation:${local.region}:${local.account}:stack/${var.api_stack_name}/*"
  sam_changesets_arn  = "arn:aws:cloudformation:${local.region}:${local.account}:changeSet/samcli-deploy*/*"
  serverless_xform    = "arn:aws:cloudformation:${local.region}:aws:transform/Serverless-2016-10-31"
  function_name       = "${local.name}-api"
  lambda_function_arn = "arn:aws:lambda:${local.region}:${local.account}:function:${local.function_name}"
  function_role_arn   = "arn:aws:iam::${local.account}:role/${local.name}-api-function"
  lambda_log_groups = [
    "arn:aws:logs:${local.region}:${local.account}:log-group:/aws/lambda/${local.function_name}",
    "arn:aws:logs:${local.region}:${local.account}:log-group:/aws/lambda/${local.function_name}:*",
  ]
  alarm_arn = "arn:aws:cloudwatch:${local.region}:${local.account}:alarm:${local.name}-*"
  topic_arn = "arn:aws:sns:${local.region}:${local.account}:${local.name}-*"

  # SSM parameters. The API key is created by a human and read only by the function.
  origin_secret_param_arn = "arn:aws:ssm:${local.region}:${local.account}:parameter/${local.name}/origin-verify-secret"
  api_key_param_arn       = "arn:aws:ssm:${local.region}:${local.account}:parameter/${local.name}/anthropic-api-key"
  project_params_arn      = "arn:aws:ssm:${local.region}:${local.account}:parameter/${local.name}/*"
  kms_keys_arn            = "arn:aws:kms:${local.region}:${local.account}:key/*"
  ssm_service             = "ssm.${local.region}.amazonaws.com"

  # Terraform state of infra/terraform/platform (the .tflock file sits next to it).
  state_bucket_arn   = "arn:aws:s3:::${var.state_bucket}"
  platform_state_arn = "arn:aws:s3:::${var.state_bucket}/${var.platform_state_key}"

  # Edge resources created by infra/terraform/platform and scoped by name.
  zone_arn             = "arn:aws:route53:::hostedzone/${var.hosted_zone_id}"
  cf_function_arn      = "arn:aws:cloudfront::${local.account}:function/${local.name}-*"
  web_acl_arn          = "arn:aws:wafv2:${local.region}:${local.account}:global/webacl/${local.name}-*/*"
  managed_rulesets_arn = "arn:aws:wafv2:${local.region}:*:global/managedruleset/*/*"
}

# Resources with generated ids, scoped to the ids pinned after the first deploy (variables.tf).
# Each ARN list is empty until its id is set, and pins.tf drops statements with no resources.
locals {
  # API Gateway authorizes tag calls on /tags/<URL-encoded resource ARN>. The trailing * covers
  # the API's own stages; API ids are unique, so no other API's ARN starts with this one.
  http_api_arns = var.http_api_id == "" ? [] : [
    "arn:aws:apigateway:${local.region}::/apis/${var.http_api_id}",
  ]
  http_api_child_arns = var.http_api_id == "" ? [] : [
    "arn:aws:apigateway:${local.region}::/apis/${var.http_api_id}/*",
    "arn:aws:apigateway:${local.region}::/tags/arn%3Aaws%3Aapigateway%3A${local.region}%3A%3A%2Fapis%2F${var.http_api_id}*",
  ]
  distribution_arns = var.distribution_id == "" ? [] : [
    "arn:aws:cloudfront::${local.account}:distribution/${var.distribution_id}",
  ]
  oac_arns = var.origin_access_control_id == "" ? [] : [
    "arn:aws:cloudfront::${local.account}:origin-access-control/${var.origin_access_control_id}",
  ]
  headers_policy_arns = var.response_headers_policy_id == "" ? [] : [
    "arn:aws:cloudfront::${local.account}:response-headers-policy/${var.response_headers_policy_id}",
  ]
  certificate_arns = var.certificate_id == "" ? [] : [
    "arn:aws:acm:${local.region}:${local.account}:certificate/${var.certificate_id}",
  ]
}
