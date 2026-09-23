variable "aws_account_id" {
  description = "The only AWS account this configuration may touch."
  type        = string
  default     = "388773186626"

  validation {
    condition     = can(regex("^[0-9]{12}$", var.aws_account_id))
    error_message = "aws_account_id must be a 12-digit account id."
  }
}

variable "region" {
  description = "Region for every regional resource. CloudFront certificates and WAF must be in us-east-1."
  type        = string
  default     = "us-east-1"

  validation {
    condition     = var.region == "us-east-1"
    error_message = "This project runs in us-east-1 only (CloudFront needs its certificate and WAF there)."
  }
}

variable "github_repository" {
  description = "GitHub repository (owner/name), used for tags and documentation."
  type        = string
  default     = "Brdjx/tour-of-italy"
}

# Decision: the repository uses GitHub's immutable OIDC subject format (repositories created
# after 2026-07-15 get it by default). The sub claim is then
# repo:<owner>@<owner-id>/<repo>@<repo-id>:<context>, never repo:<owner>/<repo>:<context>.
# Verified with: gh api repos/Brdjx/tour-of-italy/actions/oidc/customization/sub
# (sub_claim_prefix). The ids also stop a deleted and re-created repository from inheriting trust.
variable "github_subject_prefix" {
  description = "Prefix of the GitHub OIDC sub claim for this repository (immutable format)."
  type        = string
  default     = "repo:Brdjx@8014925/tour-of-italy@1383701312"

  validation {
    condition     = can(regex("^repo:[A-Za-z0-9-]+@[0-9]+/[A-Za-z0-9._-]+@[0-9]+$", var.github_subject_prefix))
    error_message = "github_subject_prefix must look like repo:<owner>@<owner-id>/<repo>@<repo-id> with no wildcards."
  }
}

# Decision: trust only runs started by these GitHub accounts (immutable ids, never names). The
# repository is private on GitHub Free, which offers no branch protection, rulesets, environment
# protection or required reviewers, so any collaborator with write access could otherwise run
# their own workflow code with AWS credentials. Adding a collaborator is then a reviewed change.
variable "github_actor_ids" {
  description = "GitHub account ids whose workflow runs may assume the CI roles (8014925 is Brdjx)."
  type        = list(string)
  default     = ["8014925"]

  validation {
    condition     = length(var.github_actor_ids) > 0 && alltrue([for id in var.github_actor_ids : can(regex("^[0-9]+$", id))])
    error_message = "github_actor_ids must list at least one numeric GitHub account id."
  }
}

variable "github_oidc_provider_arn" {
  description = "ARN of the existing GitHub Actions OIDC provider. It is read, never created."
  type        = string
  default     = "arn:aws:iam::388773186626:oidc-provider/token.actions.githubusercontent.com"
}

variable "state_bucket" {
  description = "Existing Terraform state bucket shared with other stacks."
  type        = string
  default     = "fortissimo-terraform-state"
}

variable "platform_state_key" {
  description = "State key of infra/terraform/platform, the only state CI may read or write."
  type        = string
  default     = "tour-of-italy/platform.tfstate"
}

variable "api_stack_name" {
  description = "CloudFormation stack deployed by SAM (infra/sam/samconfig.toml stack_name)."
  type        = string
  default     = "italy-planner-api"
}

variable "domain_name" {
  description = "Public host name of the site."
  type        = string
  default     = "stripe.brdjx.com"
}

variable "hosted_zone_id" {
  description = "Route 53 hosted zone that holds domain_name (brdjx.com)."
  type        = string
  default     = "Z0808500BKXP102OKNM9"
}

variable "budget_limit_usd" {
  description = "Monthly AWS cost budget for resources tagged Project=italy-planner, in USD."
  type        = number
  default     = 20

  validation {
    condition     = var.budget_limit_usd >= 1 && var.budget_limit_usd <= 1000
    error_message = "budget_limit_usd must be between 1 and 1000."
  }
}

variable "budget_email" {
  description = "Address that receives budget alerts."
  type        = string
  default     = "bradley@fortissimo.io"

  validation {
    condition     = can(regex("^[^@\\s]+@[^@\\s]+\\.[^@\\s]+$", var.budget_email))
    error_message = "budget_email must be an email address."
  }
}

# Ids of the singleton resources the first (admin) deploy creates. The deploy and plan roles are
# scoped to exactly these ids, because HTTP API children, origin access controls and response
# headers policies cannot be scoped by name or tag, and tag conditions can be widened by tagging
# another stack's resource. Empty means "not deployed yet": the roles then get no rights on that
# resource at all. docs/deploy.md shows how to fill deployed-ids.auto.tfvars after the first deploy.
variable "http_api_id" {
  description = "Id of the HTTP API in the italy-planner-api stack (SAM output HttpApiId)."
  type        = string
  default     = ""

  validation {
    condition     = can(regex("^([a-z0-9]{10})?$", var.http_api_id))
    error_message = "http_api_id must be empty or a 10-character API Gateway id."
  }
}

variable "distribution_id" {
  description = "Id of the CloudFront distribution (platform output distribution_id)."
  type        = string
  default     = ""

  validation {
    condition     = can(regex("^(E[A-Z0-9]{7,20})?$", var.distribution_id))
    error_message = "distribution_id must be empty or a CloudFront distribution id."
  }
}

variable "origin_access_control_id" {
  description = "Id of the web bucket's origin access control (platform output origin_access_control_id)."
  type        = string
  default     = ""

  validation {
    condition     = can(regex("^(E[A-Z0-9]{7,20})?$", var.origin_access_control_id))
    error_message = "origin_access_control_id must be empty or a CloudFront origin access control id."
  }
}

variable "response_headers_policy_id" {
  description = "Id of the security headers policy (platform output response_headers_policy_id)."
  type        = string
  default     = ""

  validation {
    condition     = can(regex("^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})?$", var.response_headers_policy_id))
    error_message = "response_headers_policy_id must be empty or a policy id (UUID)."
  }
}

variable "certificate_id" {
  description = "Id (last part of the ARN) of the site certificate (platform output certificate_arn)."
  type        = string
  default     = ""

  validation {
    condition     = can(regex("^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})?$", var.certificate_id))
    error_message = "certificate_id must be empty or an ACM certificate id (UUID)."
  }
}
