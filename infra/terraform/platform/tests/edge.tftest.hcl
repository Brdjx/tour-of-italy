# terraform test, platform root: CloudFront behaviors and security headers (WAF: waf.tftest.hcl).
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

run "site_never_serves_plain_http" {
  command = plan

  assert {
    condition     = aws_cloudfront_distribution.site.default_cache_behavior[0].viewer_protocol_policy == "redirect-to-https"
    error_message = "The site behavior must redirect HTTP to HTTPS."
  }

  assert {
    condition     = one([for b in aws_cloudfront_distribution.site.ordered_cache_behavior : b.viewer_protocol_policy if b.path_pattern == "/api/*"]) == "https-only"
    error_message = "The /api/* behavior must refuse plain HTTP (a redirected POST would lose its body)."
  }

  assert {
    condition     = aws_cloudfront_distribution.site.viewer_certificate[0].minimum_protocol_version == "TLSv1.2_2021" && aws_cloudfront_distribution.site.viewer_certificate[0].ssl_support_method == "sni-only"
    error_message = "Viewers must use TLS 1.2 or newer with SNI."
  }

  assert {
    condition     = aws_cloudfront_distribution.site.web_acl_id == "arn:aws:wafv2:us-east-1:388773186626:global/webacl/italy-planner-web/test"
    error_message = "The distribution must be protected by the italy-planner web ACL."
  }
}

run "api_requests_reach_the_api_uncached_and_see_the_viewer" {
  command = plan

  assert {
    condition     = one([for b in aws_cloudfront_distribution.site.ordered_cache_behavior : b.target_origin_id if b.path_pattern == "/api/*"]) == "api"
    error_message = "/api/* must be routed to the API origin; the S3 origin would answer every API call with 403 or 404."
  }

  assert {
    condition     = aws_cloudfront_distribution.site.default_cache_behavior[0].target_origin_id == "web"
    error_message = "The site behavior must serve from the web bucket, never from the API."
  }

  # Literal AWS managed policy ids (platform/data.tf): CachingDisabled 4135ea2d..., CachingOptimized
  # 658327ea..., AllViewerExceptHostHeader b689b0a8...
  assert {
    condition     = one([for b in aws_cloudfront_distribution.site.ordered_cache_behavior : b.cache_policy_id if b.path_pattern == "/api/*"]) == "4135ea2d-6df8-44a3-9df3-4b5a84be39ad"
    error_message = "/api/* must use Managed-CachingDisabled (a cached plan or health answer would leak between users)."
  }

  assert {
    condition     = one([for b in aws_cloudfront_distribution.site.ordered_cache_behavior : b.origin_request_policy_id if b.path_pattern == "/api/*"]) == "b689b0a8-53d0-40ab-baf2-68738e2966ac"
    error_message = "/api/* must forward viewer headers except Host (API Gateway rejects a foreign Host; the API needs the client IP and body type)."
  }

  assert {
    condition     = aws_cloudfront_distribution.site.default_cache_behavior[0].cache_policy_id == "658327ea-f89d-4fab-a63d-7e88639e58f6"
    error_message = "The static site must use Managed-CachingOptimized."
  }

  assert {
    condition     = contains(one([for b in aws_cloudfront_distribution.site.ordered_cache_behavior : b.allowed_methods if b.path_pattern == "/api/*"]), "POST")
    error_message = "/api/* must allow POST, or planning a trip fails at the edge."
  }

  assert {
    condition     = alltrue([for b in aws_cloudfront_distribution.site.ordered_cache_behavior : length(b.function_association) == 0])
    error_message = "The directory index rewrite must never run on /api/* requests."
  }
}

run "static_site_routes_and_errors_resolve" {
  command = plan

  assert {
    condition     = aws_cloudfront_distribution.site.default_root_object == "index.html"
    error_message = "The root URL must serve index.html."
  }

  assert {
    condition     = one([for r in aws_cloudfront_distribution.site.custom_error_response : r.response_page_path if r.error_code == 404]) == "/404.html"
    error_message = "Missing pages must get the site's 404 page."
  }

  assert {
    condition     = alltrue([for r in aws_cloudfront_distribution.site.custom_error_response : r.error_caching_min_ttl == 0 if r.error_code >= 500])
    error_message = "5xx responses must never be cached at the edge."
  }

  assert {
    condition     = one([for f in aws_cloudfront_distribution.site.default_cache_behavior[0].function_association : f.event_type]) == "viewer-request"
    error_message = "Directory URLs must be rewritten to index.html on the site behavior."
  }
}

run "security_headers_allow_the_pwa_and_nothing_more" {
  command = plan

  assert {
    condition = alltrue([
      for d in ["worker-src 'self'", "manifest-src 'self'", "frame-ancestors 'none'", "object-src 'none'", "base-uri 'self'", "default-src 'self'"] :
      strcontains(aws_cloudfront_response_headers_policy.security.security_headers_config[0].content_security_policy[0].content_security_policy, d)
    ])
    error_message = "The CSP must allow the service worker and manifest and keep framing, plugins and base URI locked."
  }

  assert {
    condition     = !strcontains(aws_cloudfront_response_headers_policy.security.security_headers_config[0].content_security_policy[0].content_security_policy, "unsafe-eval")
    error_message = "The CSP must never allow eval."
  }

  assert {
    condition     = length(aws_cloudfront_response_headers_policy.security.security_headers_config[0].content_security_policy[0].content_security_policy) <= 1783
    error_message = "The CSP exceeds CloudFront's 1783 character limit and would fail to apply."
  }

  assert {
    condition     = aws_cloudfront_response_headers_policy.security.security_headers_config[0].strict_transport_security[0].access_control_max_age_sec >= 31536000
    error_message = "HSTS must last at least a year."
  }

  assert {
    condition     = aws_cloudfront_response_headers_policy.security.security_headers_config[0].frame_options[0].frame_option == "DENY"
    error_message = "The site must not be framed (clickjacking)."
  }
}
