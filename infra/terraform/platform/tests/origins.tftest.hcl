# terraform test, platform root: API origin secret, web bucket, DNS and input checks.
# Mocked providers, plan only: no credentials, no AWS calls.
# Each run names the misconfiguration it prevents. Run: terraform -chdir=infra/terraform/platform test

mock_provider "aws" {
  override_during = plan
}

mock_provider "random" {
  override_during = plan
}

override_data {
  target          = data.aws_cloudformation_stack.api
  override_during = plan
  values = {
    outputs = { HttpApiDomain = "abc123def4.execute-api.us-east-1.amazonaws.com" }
  }
}

override_resource {
  target          = aws_cloudfront_distribution.site
  override_during = plan
  values = {
    arn         = "arn:aws:cloudfront::388773186626:distribution/E2TESTDIST"
    id          = "E2TESTDIST"
    domain_name = "d111111abcdef8.cloudfront.net"
  }
}

override_resource {
  target          = aws_wafv2_web_acl.edge
  override_during = plan
  values          = { arn = "arn:aws:wafv2:us-east-1:388773186626:global/webacl/italy-planner-web/test" }
}

override_resource {
  target          = random_password.origin_verify
  override_during = plan
  values          = { result = "testsecretvalue0123456789testsecretvalue01234567" }
}

run "api_origin_cannot_be_reached_without_the_origin_secret" {
  command = plan

  assert {
    condition = one([
      for o in aws_cloudfront_distribution.site.origin : o.domain_name if o.origin_id == "api"
    ]) == "abc123def4.execute-api.us-east-1.amazonaws.com"
    error_message = "The /api/* origin must be the SAM stack's HttpApiDomain output."
  }

  assert {
    condition = one(flatten([
      for o in aws_cloudfront_distribution.site.origin : [for h in o.custom_header : h.value if h.name == "x-origin-verify"] if o.origin_id == "api"
    ])) == aws_ssm_parameter.origin_verify.value
    error_message = "CloudFront must send the same origin secret the function reads from SSM."
  }

  assert {
    condition = alltrue(flatten([
      for o in aws_cloudfront_distribution.site.origin : [
        for c in o.custom_origin_config : c.origin_protocol_policy == "https-only" && c.origin_ssl_protocols == toset(["TLSv1.2"])
      ]
    ]))
    error_message = "CloudFront must reach the API over TLS 1.2 only."
  }

  assert {
    condition     = aws_ssm_parameter.origin_verify.type == "SecureString" && aws_ssm_parameter.origin_verify.name == "/italy-planner/origin-verify-secret"
    error_message = "The origin secret must be the SecureString the SAM template points the function at."
  }

  assert {
    condition     = random_password.origin_verify.length >= 32 && random_password.origin_verify.special == false
    error_message = "The origin secret must be long and header-safe."
  }
}

run "web_bucket_is_private_and_readable_only_by_this_distribution" {
  command = plan

  assert {
    condition = alltrue([
      aws_s3_bucket_public_access_block.web.block_public_acls,
      aws_s3_bucket_public_access_block.web.block_public_policy,
      aws_s3_bucket_public_access_block.web.ignore_public_acls,
      aws_s3_bucket_public_access_block.web.restrict_public_buckets,
    ])
    error_message = "Every public access block setting must be on for the web bucket."
  }

  assert {
    condition     = aws_s3_bucket_ownership_controls.web.rule[0].object_ownership == "BucketOwnerEnforced"
    error_message = "ACLs must be disabled so no object can be made public by ACL."
  }

  assert {
    condition = anytrue([
      for s in jsondecode(aws_s3_bucket_policy.web.policy).Statement :
      s.Effect == "Deny" && s.Condition.Bool["aws:SecureTransport"] == "false"
    ])
    error_message = "The web bucket must deny requests that do not use TLS."
  }

  assert {
    condition = alltrue([
      for s in jsondecode(aws_s3_bucket_policy.web.policy).Statement :
      s.Principal == { Service = "cloudfront.amazonaws.com" } && s.Condition.StringEquals["AWS:SourceArn"] == "arn:aws:cloudfront::388773186626:distribution/E2TESTDIST"
      if s.Effect == "Allow"
    ])
    error_message = "Only this distribution (AWS:SourceArn) may read the bucket."
  }

  assert {
    condition     = aws_cloudfront_origin_access_control.web.signing_behavior == "always" && aws_cloudfront_origin_access_control.web.origin_access_control_origin_type == "s3"
    error_message = "CloudFront must sign every request to S3 (origin access control)."
  }
}

run "dns_points_only_the_site_name_at_the_distribution" {
  command = plan

  assert {
    condition     = alltrue([for r in aws_route53_record.site : r.name == "stripe.brdjx.com" && r.zone_id == "Z0808500BKXP102OKNM9" && r.allow_overwrite == false])
    error_message = "Only stripe.brdjx.com may be written, and never over an existing record."
  }

  assert {
    condition     = toset([for r in aws_route53_record.site : r.type]) == toset(["A", "AAAA"])
    error_message = "The site needs both IPv4 and IPv6 alias records."
  }

  assert {
    condition     = aws_acm_certificate.site.domain_name == "stripe.brdjx.com" && aws_acm_certificate.site.validation_method == "DNS"
    error_message = "The certificate must cover the site name and validate through DNS."
  }
}

run "refuses_to_plan_without_the_sam_stack_output" {
  command = plan

  override_data {
    target          = data.aws_cloudformation_stack.api
    override_during = plan
    values          = { outputs = {} }
  }

  expect_failures = [aws_cloudfront_distribution.site]
}

run "rejects_a_plan_rate_limit_waf_cannot_enforce" {
  command = plan

  variables {
    plan_rate_limit = 5
  }

  expect_failures = [var.plan_rate_limit]
}
