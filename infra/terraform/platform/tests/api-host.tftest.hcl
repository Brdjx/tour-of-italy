# terraform test, platform root: the API host's distribution (api.italy-planner.brdjx.com).
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
  target          = aws_cloudfront_response_headers_policy.security
  override_during = plan
  values          = { id = "11111111-2222-3333-4444-555555555555" }
}

# A known certificate ARN needs the validation options too (certificate.tf indexes them by name).
override_resource {
  target          = aws_acm_certificate.site
  override_during = plan
  values = {
    arn = "arn:aws:acm:us-east-1:388773186626:certificate/66666666-7777-8888-9999-000000000000"
    domain_validation_options = [
      {
        domain_name           = "italy-planner.brdjx.com"
        resource_record_name  = "_0123456789abcdef0123456789abcdef.italy-planner.brdjx.com."
        resource_record_type  = "CNAME"
        resource_record_value = "_fedcba9876543210fedcba9876543210.acm-validations.aws."
      },
      {
        domain_name           = "api.italy-planner.brdjx.com"
        resource_record_name  = "_abcdef0123456789abcdef0123456789.api.italy-planner.brdjx.com."
        resource_record_type  = "CNAME"
        resource_record_value = "_9876543210fedcba9876543210fedcba.acm-validations.aws."
      },
    ]
  }
}

override_resource {
  target          = random_password.origin_verify
  override_during = plan
  values          = { result = "testsecretvalue0123456789testsecretvalue01234567" }
}

run "api_host_reaches_only_the_api_and_carries_the_origin_secret" {
  command = plan

  # Hono serves everything under /api, so without the origin path /health would be a 404.
  assert {
    condition     = one(aws_cloudfront_distribution.api.origin).domain_name == "abc123def4.execute-api.us-east-1.amazonaws.com" && one(aws_cloudfront_distribution.api.origin).origin_path == "/api"
    error_message = "The API host's only origin must be the SAM stack's HttpApiDomain with origin path /api."
  }

  # Without the header the function answers every request with 403.
  assert {
    condition     = one([for h in one(aws_cloudfront_distribution.api.origin).custom_header : h.value if h.name == "x-origin-verify"]) == aws_ssm_parameter.origin_verify.value
    error_message = "The API host must send the same origin secret the function reads from SSM."
  }

  # The web bucket is readable only by the site distribution; the API host has no business there.
  assert {
    condition = alltrue([
      for o in aws_cloudfront_distribution.api.origin :
      length(o.custom_origin_config) == 1 && length(o.s3_origin_config) == 0 && try(o.origin_access_control_id, null) == null && !strcontains(o.domain_name, ".s3.")
    ])
    error_message = "The API host must have no S3 origin and no origin access control."
  }

  assert {
    condition = alltrue([
      for c in one(aws_cloudfront_distribution.api.origin).custom_origin_config :
      c.origin_protocol_policy == "https-only" && c.origin_ssl_protocols == toset(["TLSv1.2"])
    ])
    error_message = "The API host must reach the API over TLS 1.2 only."
  }
}

run "api_host_passes_every_request_through_uncached" {
  command = plan

  # Literal AWS managed policy ids (platform/data.tf): CachingDisabled 4135ea2d...,
  # AllViewerExceptHostHeader b689b0a8...
  assert {
    condition     = aws_cloudfront_distribution.api.default_cache_behavior[0].cache_policy_id == "4135ea2d-6df8-44a3-9df3-4b5a84be39ad"
    error_message = "The API host must use Managed-CachingDisabled (a cached plan or health answer would leak between callers)."
  }

  assert {
    condition     = aws_cloudfront_distribution.api.default_cache_behavior[0].origin_request_policy_id == "b689b0a8-53d0-40ab-baf2-68738e2966ac"
    error_message = "The API host must forward viewer headers except Host (API Gateway rejects a foreign Host)."
  }

  assert {
    condition     = toset(aws_cloudfront_distribution.api.default_cache_behavior[0].allowed_methods) == toset(["DELETE", "GET", "HEAD", "OPTIONS", "PATCH", "POST", "PUT"])
    error_message = "The API host must allow every method, or POST /plan fails at the edge."
  }

  assert {
    condition     = aws_cloudfront_distribution.api.default_cache_behavior[0].target_origin_id == "api" && length(aws_cloudfront_distribution.api.ordered_cache_behavior) == 0
    error_message = "Every API host path must go to the API origin."
  }

  assert {
    condition     = length(aws_cloudfront_distribution.api.default_cache_behavior[0].function_association) == 0
    error_message = "The site's directory index rewrite must never run on the API host."
  }
}

run "api_host_serves_only_its_name_over_https" {
  command = plan

  assert {
    condition     = aws_cloudfront_distribution.api.aliases == toset(["api.italy-planner.brdjx.com"])
    error_message = "The API distribution must answer for api.italy-planner.brdjx.com only."
  }

  assert {
    condition     = aws_cloudfront_distribution.api.default_cache_behavior[0].viewer_protocol_policy == "redirect-to-https"
    error_message = "Plain HTTP to the API host must be redirected to HTTPS."
  }

  assert {
    condition = (
      aws_cloudfront_distribution.api.viewer_certificate[0].acm_certificate_arn == "arn:aws:acm:us-east-1:388773186626:certificate/66666666-7777-8888-9999-000000000000" &&
      aws_cloudfront_distribution.api.viewer_certificate[0].minimum_protocol_version == "TLSv1.2_2021" &&
      aws_cloudfront_distribution.api.viewer_certificate[0].ssl_support_method == "sni-only"
    )
    error_message = "The API host must use the validated certificate with TLS 1.2 or newer and SNI."
  }

  assert {
    condition     = aws_cloudfront_distribution.api.price_class == "PriceClass_100" && aws_cloudfront_distribution.api.http_version == "http2and3" && aws_cloudfront_distribution.api.is_ipv6_enabled
    error_message = "The API host must match the site's edge settings (price class, HTTP/3, IPv6)."
  }
}

run "both_hosts_share_the_waf_and_security_headers" {
  command = plan

  assert {
    condition = alltrue([
      for d in [aws_cloudfront_distribution.site, aws_cloudfront_distribution.api] :
      d.web_acl_id == "arn:aws:wafv2:us-east-1:388773186626:global/webacl/italy-planner-web/test"
    ])
    error_message = "Both distributions must be protected by the italy-planner web ACL (rate limits and managed rules)."
  }

  assert {
    condition     = aws_cloudfront_distribution.api.default_cache_behavior[0].response_headers_policy_id == "11111111-2222-3333-4444-555555555555"
    error_message = "The API host must send the same security headers (HSTS, nosniff, frame protection) as the site."
  }
}

run "api_errors_pass_through_as_json_and_are_never_cached" {
  command = plan

  # An error page would replace the API's JSON error body; a cached 5xx would reach every caller.
  assert {
    condition = alltrue([
      for r in aws_cloudfront_distribution.api.custom_error_response :
      try(r.response_page_path, null) == null && try(r.response_code, null) == null && r.error_caching_min_ttl == 0
    ])
    error_message = "API host error responses may only turn error caching off, never replace the body or status."
  }

  assert {
    condition     = length(setsubtract([400, 403, 404, 500, 502, 503, 504], [for r in aws_cloudfront_distribution.api.custom_error_response : r.error_code])) == 0
    error_message = "Client and server errors from the API must never be cached at the edge."
  }
}
