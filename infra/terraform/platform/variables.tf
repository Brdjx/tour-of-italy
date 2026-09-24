# Every variable has a default: CI runs `terraform apply` with no -var flags (apply-platform.sh).

variable "aws_account_id" {
  description = "The only AWS account this configuration may touch."
  type        = string
  default     = "388773186626"
}

variable "region" {
  description = "CloudFront needs its certificate and WAF in us-east-1, so everything lives there."
  type        = string
  default     = "us-east-1"

  validation {
    condition     = var.region == "us-east-1"
    error_message = "This project runs in us-east-1 only."
  }
}

# Decision: two host names. The web app calls /api/* on its own host (same origin: no CORS
# preflight, a simple CSP), and the API host serves scripts, evals and tool clients without the
# /api prefix. Both must be italy-planner.brdjx.com or names under it: the brdjx.com zone below
# is shared with other stacks. infra/terraform/bootstrap allows DNS changes for exactly these
# names (infra/test/hostnames.test.ts keeps the two roots in step).
variable "site_domain" {
  description = "Host name of the web app. The browser calls /api/* on this same host."
  type        = string
  default     = "italy-planner.brdjx.com"

  validation {
    condition     = can(regex("^([a-z0-9]([a-z0-9-]*[a-z0-9])?\\.)*italy-planner\\.brdjx\\.com$", var.site_domain))
    error_message = "site_domain must be italy-planner.brdjx.com or a lowercase name under it, with no wildcard (the brdjx.com zone is shared with other stacks)."
  }
}

variable "api_domain" {
  description = "Host name of the public API (paths without /api, for example /health and /plan)."
  type        = string
  default     = "api.italy-planner.brdjx.com"

  validation {
    condition     = can(regex("^([a-z0-9]([a-z0-9-]*[a-z0-9])?\\.)*italy-planner\\.brdjx\\.com$", var.api_domain)) && var.api_domain != var.site_domain
    error_message = "api_domain must be italy-planner.brdjx.com or a lowercase name under it, with no wildcard (the brdjx.com zone is shared with other stacks), and differ from site_domain."
  }
}

variable "hosted_zone_id" {
  description = "Route 53 hosted zone for brdjx.com."
  type        = string
  default     = "Z0808500BKXP102OKNM9"
}

variable "api_stack_name" {
  description = "SAM stack whose HttpApiDomain output is the origin of /api/* and of the API host."
  type        = string
  default     = "italy-planner-api"
}

variable "plan_rate_limit" {
  description = "WAF: requests per IP per 5 minutes to /api/plan (site) and /plan (API host) before the IP gets 429s."
  type        = number
  default     = 30

  validation {
    # 10 is the smallest limit AWS WAF accepts for a rate-based rule.
    condition     = var.plan_rate_limit >= 10 && var.plan_rate_limit <= 1000
    error_message = "plan_rate_limit must be between 10 and 1000 requests per 5 minutes."
  }
}

variable "global_rate_limit" {
  description = "WAF: requests per IP per 5 minutes to anything on either host before the IP gets 429s."
  type        = number
  default     = 2000

  validation {
    condition     = var.global_rate_limit >= 100 && var.global_rate_limit <= 100000
    error_message = "global_rate_limit must be between 100 and 100000 requests per 5 minutes."
  }
}

variable "origin_secret_rotation" {
  description = "Change this value (for example to today's date) to rotate the origin-verify secret."
  type        = string
  default     = "1"
}
