// CloudFront Function (cloudfront-js-2.0), viewer request, default (S3) behavior only.
//
// Next.js exports every route as <route>/index.html (trailingSlash: true). CloudFront's default
// root object only covers "/", and the S3 REST origin has no index documents, so /trip/ and
// /trip would miss. This maps both to /trip/index.html. Paths with a file extension in the last
// segment (/_next/static/x.js, /sw.js, /manifest.webmanifest) pass through unchanged.
// /api/* uses another cache behavior and never runs this function.
//
// Decision: rewrite instead of redirecting /trip to /trip/. A rewrite keeps the query string
// without rebuilding it and costs no extra round trip.
// biome-ignore lint/correctness/noUnusedVariables: CloudFront calls the function by this name.
function handler(event) {
  const request = event.request;
  const uri = request.uri;

  if (uri.charAt(uri.length - 1) === "/") {
    request.uri = `${uri}index.html`;
    return request;
  }

  const lastSegment = uri.substring(uri.lastIndexOf("/") + 1);
  if (lastSegment.indexOf(".") === -1) {
    request.uri = `${uri}/index.html`;
  }
  return request;
}
