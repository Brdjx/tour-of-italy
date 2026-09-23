# terraform test, platform root: the web ACL in front of the whole distribution.
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

run "waf_rate_limits_the_plan_endpoint_per_ip" {
  command = plan

  assert {
    condition = one([
      for r in aws_wafv2_web_acl.edge.rule : r.statement[0].rate_based_statement[0].scope_down_statement[0].byte_match_statement[0].search_string
      if r.name == "plan-rate-per-ip"
    ]) == "/api/plan"
    error_message = "The per-IP plan rate rule must target /api/plan."
  }

  assert {
    condition = one([
      for r in aws_wafv2_web_acl.edge.rule : r.statement[0].rate_based_statement[0].limit == 30 && r.statement[0].rate_based_statement[0].aggregate_key_type == "IP" && r.statement[0].rate_based_statement[0].scope_down_statement[0].byte_match_statement[0].positional_constraint == "STARTS_WITH"
      if r.name == "plan-rate-per-ip"
    ])
    error_message = "The plan rate rule must allow 30 requests per IP per window, matching the path prefix."
  }

  assert {
    condition     = one([for r in aws_wafv2_web_acl.edge.rule : r.action[0].block[0].custom_response[0].response_code if r.name == "plan-rate-per-ip"]) == 429
    error_message = "Rate-limited callers must get 429, so the web app can explain it."
  }

  assert {
    condition     = length([for r in aws_wafv2_web_acl.edge.rule : r.name if r.name == "global-rate-per-ip"]) == 1
    error_message = "A global per-IP rate rule must exist."
  }

  assert {
    condition     = aws_wafv2_web_acl.edge.scope == "CLOUDFRONT"
    error_message = "The web ACL must be CloudFront scoped."
  }
}

run "plan_rate_limit_cannot_be_dodged_with_encoded_or_dot_segment_paths" {
  command = plan

  # /api/%2e/plan, /api/./plan and /api/x/../plan all reach POST /api/plan in the function, so
  # the rule must see the path decoded, then normalized, then lowercased, in that order.
  assert {
    condition = toset([
      for t in one([
        for r in aws_wafv2_web_acl.edge.rule : r.statement[0].rate_based_statement[0].scope_down_statement[0].byte_match_statement[0].text_transformation
        if r.name == "plan-rate-per-ip"
      ]) : "${t.priority}:${t.type}"
    ]) == toset(["0:URL_DECODE", "1:NORMALIZE_PATH_WIN", "2:LOWERCASE"])
    error_message = "The plan rule must URL-decode, then normalize the path, then lowercase it."
  }
}

run "managed_rules_never_block_long_share_links" {
  command = plan

  assert {
    condition = toset([
      for r in aws_wafv2_web_acl.edge.rule : r.statement[0].managed_rule_group_statement[0].name if length(r.statement[0].managed_rule_group_statement) > 0
    ]) == toset(["AWSManagedRulesAmazonIpReputationList", "AWSManagedRulesKnownBadInputsRuleSet", "AWSManagedRulesCommonRuleSet"])
    error_message = "The managed rule groups (common, known bad inputs, IP reputation) must be present."
  }

  # A share link carries the trip in the query string; over 2 KB the common rule set would
  # answer with a bare 403 before the page can load and show its own fallback.
  assert {
    condition = one(flatten([
      for r in aws_wafv2_web_acl.edge.rule : [
        for o in r.statement[0].managed_rule_group_statement[0].rule_action_override : length(o.action_to_use[0].count) == 1
        if o.name == "SizeRestrictions_QUERYSTRING"
      ] if length(r.statement[0].managed_rule_group_statement) > 0 && r.name == "AWSManagedRulesCommonRuleSet"
    ]))
    error_message = "SizeRestrictions_QUERYSTRING must only count, so long share links still open."
  }

  # Only that rule is relaxed: the body size limit and every other common rule still block.
  assert {
    condition = alltrue([
      for r in aws_wafv2_web_acl.edge.rule : length(r.statement[0].managed_rule_group_statement[0].rule_action_override) == (r.name == "AWSManagedRulesCommonRuleSet" ? 1 : 0)
      if length(r.statement[0].managed_rule_group_statement) > 0
    ])
    error_message = "No managed rule other than SizeRestrictions_QUERYSTRING may be downgraded to count."
  }
}
