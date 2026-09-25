"""Check that infra/ provides every name the deploy workflow relies on.

Usage: python3 .github/scripts/check-infra-contract.py [repo-root]

deploy.yml reads these after it has already changed AWS, and the pinning step in
docs/deploy.md reads the pinned-id outputs after the first deploy has created the resources. A
missing name there means a half-finished deploy, so this runs in CI (iac job) and fails the pull
request instead. It also checks the one setting the deploy role's rights depend on: the trips
table is never deleted by CloudFormation.
Standard library only: the SAM template is scanned by indentation, not parsed, because it uses
CloudFormation tags (!Ref, !Sub) that a plain YAML loader rejects.
"""

import re
import sys
from pathlib import Path

# Decision: only names deploy.yml, smoke-test.sh or the pinning step would fail without.
# Summary-only values (ApiFunctionName, distribution_domain, site_url, api_distribution_domain,
# api_url) are optional there, so they are not checked.
SAM_PARAMETERS = ["GitSha"]
SAM_OUTPUTS = ["HttpApiUrl", "HttpApiId"]
DEPLOY_OUTPUTS = ["web_bucket_name", "distribution_id"]
# Pinned in infra/terraform/bootstrap (docs/deploy.md step 7), together with the SAM HttpApiId.
PINNED_OUTPUTS = [
    "distribution_id",
    "api_distribution_id",
    "origin_access_control_id",
    "response_headers_policy_id",
    "certificate_arn",
]
TERRAFORM_OUTPUTS = sorted(set(DEPLOY_OUTPUTS + PINNED_OUTPUTS))
# The GitSha parameter must reach the function as GIT_SHA (services/api/src/config.ts), or the
# health check can never report the deployed commit.
GIT_SHA_ENV = re.compile(r"GIT_SHA:[^\n]*GitSha|GIT_SHA:[ \t]*\n[ \t]+(Ref|!Ref):?[ \t]*GitSha")
# The smoke test opens an unknown trip and expects 404, which needs the function to reach the
# trips table: TRIPS_TABLE set from the TripsTable resource (services/api/src/config.ts). Without
# it the API refuses to save trips in production, and the smoke test fails after the deploy.
TRIPS_TABLE_ENV = re.compile(
    r"TRIPS_TABLE:[^\n]*TripsTable|TRIPS_TABLE:[ \t]*\n[ \t]+(Ref|!Ref):?[ \t]*TripsTable"
)
SAM_RESOURCES = ["TripsTable"]
# The deploy role holds no dynamodb:DeleteTable (infra/terraform/bootstrap/deploy-api.tf), so the
# trips table must never be one CloudFormation deletes: Retain on delete and on replacement, and
# deletion protection on. Without them removing or renaming the resource would fail mid-deploy
# with AccessDenied, or, if the right were ever added back, delete every saved trip.
TRIPS_TABLE_SETTINGS = {
    "DeletionPolicy: Retain": re.compile(r"^\s+DeletionPolicy:\s*Retain\s*$", re.M),
    "UpdateReplacePolicy: Retain": re.compile(r"^\s+UpdateReplacePolicy:\s*Retain\s*$", re.M),
    "DeletionProtectionEnabled: true": re.compile(
        r"^\s+DeletionProtectionEnabled:\s*true\s*$", re.M
    ),
}


def section_keys(template: str, section: str) -> set[str]:
    """Keys one level under a top-level section such as Parameters or Outputs."""
    keys: set[str] = set()
    inside = False
    child_indent = None
    for line in template.splitlines():
        if not line.strip() or line.lstrip().startswith("#"):
            continue
        indent = len(line) - len(line.lstrip(" "))
        if indent == 0:
            inside = line.startswith(f"{section}:")
            child_indent = None
            continue
        if not inside:
            continue
        if child_indent is None:
            child_indent = indent
        match = re.match(r"\s*([A-Za-z0-9]+):", line)
        if indent == child_indent and match:
            keys.add(match.group(1))
    return keys


def resource_block(template: str, name: str) -> str:
    """The lines of one resource under Resources, up to the next resource or section."""
    lines: list[str] = []
    inside = False
    for line in template.splitlines():
        indent = len(line) - len(line.lstrip(" "))
        if line.strip() and not line.lstrip().startswith("#") and indent <= 2:
            inside = line == f"  {name}:"
            continue
        if inside:
            lines.append(line)
    return "\n".join(lines)


def check_sam(root: Path) -> list[str]:
    path = root / "infra/sam/template.yaml"
    if not path.is_file():
        return [f"{path} is missing"]
    template = path.read_text(encoding="utf-8")
    errors = []
    for section, wanted in (
        ("Parameters", SAM_PARAMETERS),
        ("Resources", SAM_RESOURCES),
        ("Outputs", SAM_OUTPUTS),
    ):
        missing = sorted(set(wanted) - section_keys(template, section))
        if missing:
            errors.append(f"{path}: {section} is missing {', '.join(missing)}")
    if not GIT_SHA_ENV.search(template):
        errors.append(f"{path}: no function environment variable GIT_SHA set from GitSha")
    if not TRIPS_TABLE_ENV.search(template):
        errors.append(f"{path}: no function environment variable TRIPS_TABLE set from TripsTable")
    table = resource_block(template, "TripsTable")
    for wanted, setting in TRIPS_TABLE_SETTINGS.items():
        if not setting.search(table):
            errors.append(f"{path}: TripsTable needs {wanted} (the deploy role cannot delete it)")
    return errors


def check_terraform(root: Path) -> list[str]:
    directory = root / "infra/terraform/platform"
    declared: set[str] = set()
    for tf_file in sorted(directory.glob("*.tf")):
        text = tf_file.read_text(encoding="utf-8")
        declared.update(re.findall(r'^output\s+"([A-Za-z0-9_-]+)"', text, flags=re.MULTILINE))
    missing = sorted(set(TERRAFORM_OUTPUTS) - declared)
    return [f"{directory}: missing output {name}" for name in missing]


def main() -> None:
    root = Path(sys.argv[1] if len(sys.argv) > 1 else ".")
    errors = check_sam(root) + check_terraform(root)
    for error in errors:
        print(f"::error::infra contract: {error}")
    if errors:
        sys.exit(1)
    print("Infra provides every name deploy.yml and the pinning step rely on.")


if __name__ == "__main__":
    main()
