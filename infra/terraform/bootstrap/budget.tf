# Monthly cost budget for this project's resources. The Claude API is billed by Anthropic, not
# AWS, so it is capped separately (reserved concurrency, API throttling, WAF rate rules).
#
# Decision: filter by the Project cost allocation tag, because the account is shared and an
# unfiltered budget would alert on other stacks' spend. The tag key must be activated once for
# cost allocation (account-wide billing setting, see docs/deploy.md); until then this reads $0.

resource "aws_budgets_budget" "monthly" {
  name         = "${local.name}-monthly"
  budget_type  = "COST"
  limit_amount = format("%.2f", var.budget_limit_usd)
  limit_unit   = "USD"
  time_unit    = "MONTHLY"

  cost_filter {
    name   = "TagKeyValue"
    values = [format("user:Project$%s", local.name)]
  }

  notification {
    comparison_operator        = "GREATER_THAN"
    threshold                  = 80
    threshold_type             = "PERCENTAGE"
    notification_type          = "ACTUAL"
    subscriber_email_addresses = [var.budget_email]
  }

  notification {
    comparison_operator        = "GREATER_THAN"
    threshold                  = 100
    threshold_type             = "PERCENTAGE"
    notification_type          = "FORECASTED"
    subscriber_email_addresses = [var.budget_email]
  }
}
