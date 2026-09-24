# Both host names point at their own distribution over IPv4 and IPv6.
#
# Decision: never overwrite. If a name already exists in the zone, apply fails instead of
# silently taking over a record something else depends on.

resource "aws_route53_record" "site" {
  for_each = toset(["A", "AAAA"])

  zone_id         = var.hosted_zone_id
  name            = var.site_domain
  type            = each.value
  allow_overwrite = false

  alias {
    name                   = aws_cloudfront_distribution.site.domain_name
    zone_id                = aws_cloudfront_distribution.site.hosted_zone_id
    evaluate_target_health = false
  }
}

resource "aws_route53_record" "api" {
  for_each = toset(["A", "AAAA"])

  zone_id         = var.hosted_zone_id
  name            = var.api_domain
  type            = each.value
  allow_overwrite = false

  alias {
    name                   = aws_cloudfront_distribution.api.domain_name
    zone_id                = aws_cloudfront_distribution.api.hosted_zone_id
    evaluate_target_health = false
  }
}
