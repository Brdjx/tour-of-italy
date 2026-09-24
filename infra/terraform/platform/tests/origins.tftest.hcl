# terraform test, platform root: API origin secret, web bucket, DNS, certificate and input checks.
# The API host's own distribution is covered in api-host.tftest.hcl.
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
  target          = aws_cloudfront_distribution.api
  override_during = plan
  values = {
    arn         = "arn:aws:cloudfront::388773186626:distribution/E2TESTAPIDIST"
    id          = "E2TESTAPIDIST"
    domain_name = "d222222abcdef8.cloudfront.net"
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

run "dns_points_each_host_name_at_its_own_distribution" {
  command = plan

  assert {
    condition     = alltrue([for r in aws_route53_record.site : r.name == "italy-planner.brdjx.com" && r.zone_id == "Z0808500BKXP102OKNM9" && r.allow_overwrite == false])
    error_message = "The site records must be italy-planner.brdjx.com in the brdjx.com zone, never written over an existing record."
  }

  assert {
    condition     = alltrue([for r in aws_route53_record.api : r.name == "api.italy-planner.brdjx.com" && r.zone_id == "Z0808500BKXP102OKNM9" && r.allow_overwrite == false])
    error_message = "The API host records must be api.italy-planner.brdjx.com in the brdjx.com zone, never written over an existing record."
  }

  assert {
    condition     = toset([for r in aws_route53_record.site : r.type]) == toset(["A", "AAAA"]) && toset([for r in aws_route53_record.api : r.type]) == toset(["A", "AAAA"])
    error_message = "Both host names need IPv4 and IPv6 alias records."
  }

  # Crossed aliases would send browsers to the API (no pages) and API clients to the site.
  assert {
    condition     = alltrue([for r in aws_route53_record.site : one(r.alias).name == "d111111abcdef8.cloudfront.net"])
    error_message = "The site name must point at the site distribution."
  }

  assert {
    condition     = alltrue([for r in aws_route53_record.api : one(r.alias).name == "d222222abcdef8.cloudfront.net"])
    error_message = "The API host name must point at the API distribution."
  }
}

run "one_certificate_covers_both_host_names" {
  command = plan

  assert {
    condition     = aws_acm_certificate.site.domain_name == "italy-planner.brdjx.com" && aws_acm_certificate.site.validation_method == "DNS"
    error_message = "The certificate must be for the site name and validate through DNS."
  }

  assert {
    condition     = toset(aws_acm_certificate.site.subject_alternative_names) == toset(["api.italy-planner.brdjx.com"])
    error_message = "The certificate must also name the API host, or its distribution cannot use it."
  }

  assert {
    condition     = toset(keys(aws_route53_record.certificate_validation)) == toset(["italy-planner.brdjx.com", "api.italy-planner.brdjx.com"])
    error_message = "Each certificate name needs its own validation record, or validation never completes."
  }
}

run "rejects_an_api_host_equal_to_the_site_host" {
  command = plan

  variables {
    api_domain = "italy-planner.brdjx.com"
  }

  expect_failures = [var.api_domain]
}

run "rejects_a_site_host_outside_the_zone" {
  command = plan

  variables {
    site_domain = "italy-planner.example.com"
  }

  expect_failures = [var.site_domain]
}

# The brdjx.com zone is shared with other stacks: the platform may only create names in the
# project's own subtree (the bootstrap grants DNS rights on nothing else).
run "rejects_a_site_host_outside_the_project_subtree" {
  command = plan

  variables {
    site_domain = "evilitaly-planner.brdjx.com"
  }

  expect_failures = [var.site_domain]
}

# A run of its own: Terraform skips api_domain's validation while site_domain is invalid.
run "rejects_an_api_host_outside_the_project_subtree" {
  command = plan

  variables {
    api_domain = "api.evilitaly-planner.brdjx.com"
  }

  expect_failures = [var.api_domain]
}

run "rejects_a_wildcard_api_host" {
  command = plan

  variables {
    api_domain = "*.italy-planner.brdjx.com"
  }

  expect_failures = [var.api_domain]
}

run "refuses_to_plan_without_the_sam_stack_output" {
  command = plan

  override_data {
    target          = data.aws_cloudformation_stack.api
    override_during = plan
    values          = { outputs = {} }
  }

  # Both distributions use the SAM output as their API origin, so both must refuse.
  expect_failures = [aws_cloudfront_distribution.site, aws_cloudfront_distribution.api]
}

run "rejects_a_plan_rate_limit_waf_cannot_enforce" {
  command = plan

  variables {
    plan_rate_limit = 5
  }

  expect_failures = [var.plan_rate_limit]
}
