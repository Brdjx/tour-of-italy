# One origin for the browser: the static site from S3 and /api/* from the HTTP API. Same origin
# means no CORS, and the WAF and security headers cover both.

resource "aws_cloudfront_origin_access_control" "web" {
  name                              = "${local.name}-web"
  description                       = "CloudFront reads ${local.web_bucket} with signed requests"
  origin_access_control_origin_type = "s3"
  signing_behavior                  = "always"
  signing_protocol                  = "sigv4"
}

locals {
  web_origin_id = "web"
  api_origin_id = "api"
}

resource "aws_cloudfront_distribution" "site" {
  enabled             = true
  comment             = "${local.name}: static site and /api"
  aliases             = [var.domain_name]
  default_root_object = "index.html"
  http_version        = "http2and3"
  is_ipv6_enabled     = true
  # Decision: PriceClass_100 (North America and Europe edges). The audience plans trips to Italy.
  price_class = "PriceClass_100"
  web_acl_id  = aws_wafv2_web_acl.edge.arn

  origin {
    origin_id                = local.web_origin_id
    domain_name              = aws_s3_bucket.web.bucket_regional_domain_name
    origin_access_control_id = aws_cloudfront_origin_access_control.web.id
  }

  origin {
    origin_id   = local.api_origin_id
    domain_name = local.api_origin_domain

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
    target_origin_id           = local.web_origin_id
    viewer_protocol_policy     = "redirect-to-https"
    allowed_methods            = ["GET", "HEAD", "OPTIONS"]
    cached_methods             = ["GET", "HEAD"]
    compress                   = true
    cache_policy_id            = local.managed_policy_ids.caching_optimized
    response_headers_policy_id = aws_cloudfront_response_headers_policy.security.id

    function_association {
      event_type   = "viewer-request"
      function_arn = aws_cloudfront_function.directory_index.arn
    }
  }

  ordered_cache_behavior {
    path_pattern = "/api/*"
    # Decision: https-only, not redirect. A redirected POST loses its body; HSTS already keeps
    # browsers on HTTPS, so plain HTTP API calls are refused outright.
    viewer_protocol_policy = "https-only"
    target_origin_id       = local.api_origin_id
    allowed_methods        = ["DELETE", "GET", "HEAD", "OPTIONS", "PATCH", "POST", "PUT"]
    cached_methods         = ["GET", "HEAD"]
    # Decision: false, because CloudFront only compresses when the cache policy enables
    # Accept-Encoding, and CachingDisabled cannot. The API compresses its own JSON; the origin
    # request policy forwards Accept-Encoding to it.
    compress                   = false
    cache_policy_id            = local.managed_policy_ids.caching_disabled
    origin_request_policy_id   = local.managed_policy_ids.all_viewer_except_host_header
    response_headers_policy_id = aws_cloudfront_response_headers_policy.security.id
  }

  # Missing pages get the site's own 404 page. Note: this applies to every origin, so a 404 from
  # the API also arrives as the HTML 404 page (status stays 404). Not cached, like API errors.
  custom_error_response {
    error_code            = 404
    response_code         = 404
    response_page_path    = "/404.html"
    error_caching_min_ttl = 0
  }

  # Decision: never cache API errors at the edge. CloudFront would otherwise keep a 5xx for 10
  # seconds and serve it to every visitor, turning one failed request into many.
  dynamic "custom_error_response" {
    for_each = toset([400, 403, 500, 502, 503, 504])
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
