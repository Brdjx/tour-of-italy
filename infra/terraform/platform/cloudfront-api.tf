# The public API host: https://<api_domain>/health reaches the function at /api/health. Scripts,
# evals and tool clients use it; the web app keeps calling /api/* on its own host (cloudfront.tf).
# Same origin, origin secret, WAF web ACL, certificate and headers policy as the site's /api/*
# behavior, and nothing else: no S3 origin, no origin access control, no CloudFront function.

locals {
  # The HTTP API routes /api/{proxy+} to the function (Hono basePath /api), so CloudFront adds
  # the prefix: viewer /plan becomes origin /api/plan, and viewer /api/health becomes
  # /api/api/health (a JSON 404). CloudFront adds it after the WAF has inspected the path
  # (waf.tf matches both spellings).
  api_host_origin_path = "/api"

  # Every error code CloudFront lets a distribution configure error caching for.
  api_host_error_codes = [400, 403, 404, 405, 414, 416, 500, 501, 502, 503, 504]
}

resource "aws_cloudfront_distribution" "api" {
  enabled         = true
  comment         = "${local.name}: public API (${var.api_domain})"
  aliases         = [var.api_domain]
  http_version    = "http2and3"
  is_ipv6_enabled = true
  # Decision: PriceClass_100, as for the site (North America and Europe edges).
  price_class = "PriceClass_100"
  web_acl_id  = aws_wafv2_web_acl.edge.arn

  origin {
    origin_id   = local.api_origin_id
    domain_name = local.api_origin_domain
    origin_path = local.api_host_origin_path

    custom_origin_config {
      http_port                = 80
      https_port               = 443
      origin_protocol_policy   = "https-only"
      origin_ssl_protocols     = ["TLSv1.2"]
      origin_read_timeout      = 30 # API Gateway ends requests at 30 s anyway
      origin_keepalive_timeout = 5
    }

    # CloudFront replaces any viewer-sent header of the same name with this value.
    custom_header {
      name  = "x-origin-verify"
      value = random_password.origin_verify.result
    }
  }

  default_cache_behavior {
    target_origin_id = local.api_origin_id
    # Decision: redirect, not https-only as on the site's /api/*. Someone who types the host or
    # runs curl without a scheme gets a working URL instead of a bare 403. A plain HTTP POST
    # is redirected too and arrives without its body, so it cannot plan anything; clients must
    # use https (docs/deploy.md). HSTS keeps browsers on HTTPS after the first visit.
    viewer_protocol_policy = "redirect-to-https"
    allowed_methods        = ["DELETE", "GET", "HEAD", "OPTIONS", "PATCH", "POST", "PUT"]
    cached_methods         = ["GET", "HEAD"]
    # False for the same reason as the site's /api/*: CachingDisabled cannot enable
    # Accept-Encoding, and the origin request policy forwards it so the API compresses itself.
    compress                   = false
    cache_policy_id            = local.managed_policy_ids.caching_disabled
    origin_request_policy_id   = local.managed_policy_ids.all_viewer_except_host_header
    response_headers_policy_id = aws_cloudfront_response_headers_policy.security.id
  }

  # Decision: error caching off, and no error pages. CloudFront would otherwise keep an error
  # for 10 seconds and serve it to every caller. These blocks set only the caching time: with no
  # response_page_path the API's own JSON error (status and body) passes through unchanged.
  dynamic "custom_error_response" {
    for_each = toset(local.api_host_error_codes)
    content {
      error_code            = custom_error_response.value
      error_caching_min_ttl = 0
    }
  }

  restrictions {
    geo_restriction {
      restriction_type = "none"
    }
  }

  viewer_certificate {
    acm_certificate_arn      = aws_acm_certificate_validation.site.certificate_arn
    ssl_support_method       = "sni-only"
    minimum_protocol_version = "TLSv1.2_2021"
  }

  lifecycle {
    precondition {
      condition     = can(regex("^[a-z0-9]+\\.execute-api\\.us-east-1\\.amazonaws\\.com$", local.api_origin_domain))
      error_message = "The SAM stack ${var.api_stack_name} has no usable HttpApiDomain output. Run sam deploy (infra/sam) first."
    }
  }
}
