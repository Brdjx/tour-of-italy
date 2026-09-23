# Web ACL in front of the whole distribution. Rate rules run first (cheapest, and they are the
# main cost control for the Claude-backed /api/plan), then AWS managed rule groups.

locals {
  rate_limited_body = jsonencode({
    error = {
      code    = "RATE_LIMITED"
      message = "Too many requests from your network. Wait a few minutes and try again."
    }
  })
}

resource "aws_wafv2_web_acl" "edge" {
  name        = "${local.name}-web"
  description = "Edge protection for ${var.domain_name}"
  scope       = "CLOUDFRONT"

  default_action {
    allow {}
  }

  # Same error shape as the API ({ error: { code, message } }), so the web app shows it as-is.
  custom_response_body {
    key          = "rate-limited"
    content_type = "APPLICATION_JSON"
    content      = local.rate_limited_body
  }

  rule {
    name     = "plan-rate-per-ip"
    priority = 0

    action {
      block {
        custom_response {
          response_code            = 429
          custom_response_body_key = "rate-limited"
        }
      }
    }

    statement {
      rate_based_statement {
        limit                 = var.plan_rate_limit
        evaluation_window_sec = 300
        aggregate_key_type    = "IP"

        scope_down_statement {
          byte_match_statement {
            search_string         = "/api/plan"
            positional_constraint = "STARTS_WITH"
            field_to_match {
              uri_path {}
            }
            # WAF sees the raw path, and CloudFront forwards it unnormalized, while the function
            # (the URL parser in the Lambda adapter) resolves dot segments. So decode first
            # (/api/%70lan), then normalize (/api/./plan, /api/x/../plan, //api/plan and
            # backslashes), then lowercase. Without this the plan budget falls back to the
            # global per-IP limit for anyone who adds a dot segment.
            text_transformation {
              priority = 0
              type     = "URL_DECODE"
            }
            text_transformation {
              priority = 1
              type     = "NORMALIZE_PATH_WIN"
            }
            text_transformation {
              priority = 2
              type     = "LOWERCASE"
            }
          }
        }
      }
    }

    visibility_config {
      cloudwatch_metrics_enabled = true
      metric_name                = "${local.name}-plan-rate"
      sampled_requests_enabled   = true
    }
  }

  rule {
    name     = "global-rate-per-ip"
    priority = 1

    action {
      block {
        custom_response {
          response_code            = 429
          custom_response_body_key = "rate-limited"
        }
      }
    }

    statement {
      rate_based_statement {
        limit                 = var.global_rate_limit
        evaluation_window_sec = 300
        aggregate_key_type    = "IP"
      }
    }

    visibility_config {
      cloudwatch_metrics_enabled = true
      metric_name                = "${local.name}-global-rate"
      sampled_requests_enabled   = true
    }
  }

  dynamic "rule" {
    # Decision: CommonRuleSet keeps SizeRestrictions_BODY (blocks bodies over 8 KB) as a block.
    # The largest valid plan request (8 interests, 10 must-include and 10 excluded ids, 500
    # characters of notes, even fully JSON-escaped) is under 4 KB, and the API's own limit is
    # 16 KB, so the rule only ever stops requests the API would reject anyway.
    # Decision: SizeRestrictions_QUERYSTRING (2 KB) only counts. A share link carries the trip
    # request in the query string and passes 2 KB with long or non-ASCII notes; a block would be
    # a bare 403 before the page could show its own fallback. The API reads no large queries.
    for_each = {
      AWSManagedRulesAmazonIpReputationList = { priority = 2, count_only = [] }
      AWSManagedRulesKnownBadInputsRuleSet  = { priority = 3, count_only = [] }
      AWSManagedRulesCommonRuleSet          = { priority = 4, count_only = ["SizeRestrictions_QUERYSTRING"] }
    }

    content {
      name     = rule.key
      priority = rule.value.priority

      override_action {
        none {}
      }

      statement {
        managed_rule_group_statement {
          vendor_name = "AWS"
          name        = rule.key

          dynamic "rule_action_override" {
            for_each = toset(rule.value.count_only)
            content {
              name = rule_action_override.value
              action_to_use {
                count {}
              }
            }
          }
        }
      }

      visibility_config {
        cloudwatch_metrics_enabled = true
        metric_name                = "${local.name}-${rule.key}"
        sampled_requests_enabled   = true
      }
    }
  }

  visibility_config {
    cloudwatch_metrics_enabled = true
    metric_name                = "${local.name}-web"
    sampled_requests_enabled   = true
  }
}
