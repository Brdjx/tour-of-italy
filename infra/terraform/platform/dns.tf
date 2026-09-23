# stripe.brdjx.com points at the distribution over IPv4 and IPv6.

resource "aws_route53_record" "site" {
  for_each = toset(["A", "AAAA"])

  zone_id = var.hosted_zone_id
  name    = var.domain_name
  type    = each.value
  # Decision: never overwrite. If the name already exists in the zone, apply fails instead of
  # silently taking over a record something else depends on.
  allow_overwrite = false

  alias {
    name                   = aws_cloudfront_distribution.site.domain_name
    zone_id                = aws_cloudfront_distribution.site.hosted_zone_id
    evaluate_target_health = false
  }
}
