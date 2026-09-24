# One TLS certificate for both host names, validated through DNS in the brdjx.com zone. Both
# distributions use it.

resource "aws_acm_certificate" "site" {
  domain_name               = var.site_domain
  subject_alternative_names = [var.api_domain]
  validation_method         = "DNS"

  lifecycle {
    create_before_destroy = true
  }
}

locals {
  certificate_names = [var.site_domain, var.api_domain]

  # Decision: key the validation records by the configured names, not by the certificate's
  # computed validation options, so the set of records is known before the certificate exists.
  certificate_validation = {
    for option in aws_acm_certificate.site.domain_validation_options : option.domain_name => option
  }
}

resource "aws_route53_record" "certificate_validation" {
  for_each = toset(local.certificate_names)

  zone_id = var.hosted_zone_id
  name    = local.certificate_validation[each.key].resource_record_name
  type    = local.certificate_validation[each.key].resource_record_type
  ttl     = 300
  records = [local.certificate_validation[each.key].resource_record_value]
  # Validation CNAMEs are deterministic per certificate, so re-creating one is harmless.
  allow_overwrite = true
}

resource "aws_acm_certificate_validation" "site" {
  certificate_arn         = aws_acm_certificate.site.arn
  validation_record_fqdns = [for record in aws_route53_record.certificate_validation : record.fqdn]
}
