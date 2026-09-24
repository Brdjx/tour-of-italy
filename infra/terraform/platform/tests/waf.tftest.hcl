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

run "waf_rate_limits_the_plan_endpoint_per_ip_on_both_hosts" {
  command = plan

  # /api/plan is the site's spelling, /plan the API host's (its origin path adds /api). Missing
  # either one leaves that host's plan calls under the global limit only.
  assert {
    condition = length(setintersection(toset([
      for s in one([
        for r in aws_wafv2_web_acl.edge.rule : r.statement[0].rate_based_statement[0].scope_down_statement[0].or_statement[0].statement
        if r.name == "plan-rate-per-ip"
      ]) : "${s.byte_match_statement[0].positional_constraint} ${s.byte_match_statement[0].search_string}"
    ]), toset(["STARTS_WITH /api/plan", "STARTS_WITH /plan"]))) == 2
    error_message = "The per-IP plan rate rule must match the prefixes /api/plan (site) and /plan (API host)."
  }

  assert {
    condition = alltrue([
      for s in one([
        for r in aws_wafv2_web_acl.edge.rule : r.statement[0].rate_based_statement[0].scope_down_statement[0].or_statement[0].statement
        if r.name == "plan-rate-per-ip"
      ]) : contains(["STARTS_WITH", "ENDS_WITH"], s.byte_match_statement[0].positional_constraint) && length(s.byte_match_statement[0].field_to_match[0].uri_path) == 1
    ])
    error_message = "Each plan path must be a prefix or suffix match on the URI path."
  }

  assert {
    condition = one([
      for r in aws_wafv2_web_acl.edge.rule : r.statement[0].rate_based_statement[0].limit == 30 && r.statement[0].rate_based_statement[0].aggregate_key_type == "IP"
      if r.name == "plan-rate-per-ip"
    ])
    error_message = "The plan rate rule must allow 30 requests per IP per window."
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

  # /api/%2e/plan, /api/./plan and /api/x/../plan all reach POST /api/plan in the function, and
  # /%70lan, /./plan, /x/../plan and //plan reach it through the API host. So every path match
  # must see the path decoded, then normalized, then lowercased, in that order.
  assert {
    condition = alltrue([
      for s in one([
        for r in aws_wafv2_web_acl.edge.rule : r.statement[0].rate_based_statement[0].scope_down_statement[0].or_statement[0].statement
        if r.name == "plan-rate-per-ip"
        ]) : toset([
        for t in s.byte_match_statement[0].text_transformation : "${t.priority}:${t.type}"
      ]) == toset(["0:URL_DECODE", "1:NORMALIZE_PATH_WIN", "2:LOWERCASE"])
    ])
    error_message = "Each plan path match must URL-decode, then normalize the path, then lowercase it."
  }

  # The path is lowercased before matching, so an uppercase search string could never match.
  assert {
    condition = alltrue([
      for s in one([
        for r in aws_wafv2_web_acl.edge.rule : r.statement[0].rate_based_statement[0].scope_down_statement[0].or_statement[0].statement
        if r.name == "plan-rate-per-ip"
      ]) : s.byte_match_statement[0].search_string == lower(s.byte_match_statement[0].search_string)
    ])
    error_message = "Plan path search strings must be lowercase."
  }
}

run "plan_rate_limit_counts_paths_that_start_with_a_back_reference" {
  command = plan

  # WAF keeps a back-reference at the start of the path (NORMALIZE_PATH), so /%2e%2e/api/plan is
  # inspected as /../api/plan, while the function resolves it to /api/plan (the API host adds
  # /api in front first; the site sends /api/../../api/plan as is). Only a suffix match on the
  # exact, strict plan route counts those. Exactly one such member: the whole rule set is
  # listed, so a broader suffix (for example "plan") fails here too.
  assert {
    condition = toset([
      for s in one([
        for r in aws_wafv2_web_acl.edge.rule : r.statement[0].rate_based_statement[0].scope_down_statement[0].or_statement[0].statement
        if r.name == "plan-rate-per-ip"
      ]) : "${s.byte_match_statement[0].positional_constraint} ${s.byte_match_statement[0].search_string}"
    ]) == toset(["STARTS_WITH /api/plan", "STARTS_WITH /plan", "ENDS_WITH /plan"])
    error_message = "The plan rate rule must match /api/plan and /plan as prefixes and /plan as a suffix, and nothing else."
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
