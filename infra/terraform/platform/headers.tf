# Security headers for every response (site and API), plus the directory index function.

locals {
  osm_tiles = "https://tile.openstreetmap.org https://*.tile.openstreetmap.org"

  # Content Security Policy for a Next.js static export with a service worker and a Leaflet map.
  # Checked against apps/web/out: pages load hashed scripts from /_next/static and carry inline
  # scripts (self.__next_f.push) with the React Server Components payload.
  csp_directives = [
    "default-src 'self'",
    # Decision: 'unsafe-inline' for scripts. The static export's inline payload scripts change
    # with every build and page, a CDN header cannot carry per-response nonces, and hashes for
    # every page would not fit CloudFront's header size limit. No 'unsafe-eval': the bundles do
    # not need it. Mitigations: React escapes all rendered text, connect-src only allows this
    # origin, and object-src, base-uri, form-action and frame-ancestors are locked down.
    "script-src 'self' 'unsafe-inline'",
    # Decision: 'unsafe-inline' for styles. Leaflet and React set inline style attributes.
    "style-src 'self' 'unsafe-inline'",
    # Map tiles come from OpenStreetMap (with and without the a/b/c subdomains); data: covers
    # inline marker icons.
    "img-src 'self' data: ${local.osm_tiles}",
    "font-src 'self'",
    # Decision: tiles are also allowed in connect-src because a service worker that re-fetches
    # a request uses connect-src; without it the map would break only for installed PWAs.
    "connect-src 'self' ${local.osm_tiles}",
    "worker-src 'self'",
    "manifest-src 'self'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
    "upgrade-insecure-requests",
  ]
  content_security_policy = join("; ", local.csp_directives)
}

resource "aws_cloudfront_response_headers_policy" "security" {
  name    = "${local.name}-security-headers"
  comment = "Security headers for ${var.domain_name}"

  security_headers_config {
    strict_transport_security {
      access_control_max_age_sec = 63072000 # two years
      include_subdomains         = true
      preload                    = false # preload needs the apex domain; this is a subdomain
      override                   = true
    }

    content_type_options {
      override = true
    }

    frame_options {
      frame_option = "DENY"
      override     = true
    }

    # Decision: strict-origin-when-cross-origin, not no-referrer. The OpenStreetMap tile policy
    # asks for a Referer, and this still never sends paths or query strings to other sites.
    referrer_policy {
      referrer_policy = "strict-origin-when-cross-origin"
      override        = true
    }

    # "X-XSS-Protection: 0" is the current recommendation; the old filter caused its own bugs.
    xss_protection {
      protection = false
      override   = true
    }

    content_security_policy {
      content_security_policy = local.content_security_policy
      override                = true
    }
  }

  custom_headers_config {
    items {
      header   = "Permissions-Policy"
      value    = "camera=(), microphone=(), payment=(), usb=(), browsing-topics=()"
      override = true
    }
    items {
      header   = "Cross-Origin-Opener-Policy"
      value    = "same-origin"
      override = true
    }
  }
}

resource "aws_cloudfront_function" "directory_index" {
  name    = "${local.name}-directory-index"
  runtime = "cloudfront-js-2.0"
  comment = "Map /route and /route/ to /route/index.html (Next.js static export)"
  publish = true
  code    = file("${path.module}/functions/directory-index.js")
}
