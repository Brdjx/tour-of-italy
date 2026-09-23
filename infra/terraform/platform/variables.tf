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

variable "domain_name" {
  description = "Public host name of the site."
  type        = string
  default     = "stripe.brdjx.com"
}

variable "hosted_zone_id" {
  description = "Route 53 hosted zone for brdjx.com."
  type        = string
  default     = "Z0808500BKXP102OKNM9"
}

variable "api_stack_name" {
  description = "SAM stack whose HttpApiDomain output is the /api/* origin."
  type        = string
  default     = "italy-planner-api"
}

variable "plan_rate_limit" {
  description = "WAF: requests per IP per 5 minutes to /api/plan before the IP gets 429s."
  type        = number
  default     = 30

  validation {
    # 10 is the smallest limit AWS WAF accepts for a rate-based rule.
    condition     = var.plan_rate_limit >= 10 && var.plan_rate_limit <= 1000
    error_message = "plan_rate_limit must be between 10 and 1000 requests per 5 minutes."
  }
}

variable "global_rate_limit" {
  description = "WAF: requests per IP per 5 minutes to anything on the site before the IP gets 429s."
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
