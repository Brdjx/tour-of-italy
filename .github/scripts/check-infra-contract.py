"""Check that infra/ provides every name the deploy workflow relies on.

Usage: python3 .github/scripts/check-infra-contract.py [repo-root]

deploy.yml reads these after it has already changed AWS. A missing name there means a
half-finished deploy, so this runs in CI (iac job) and fails the pull request instead.
Standard library only: the SAM template is scanned by indentation, not parsed, because it uses
CloudFormation tags (!Ref, !Sub) that a plain YAML loader rejects.
"""

import re
import sys
from pathlib import Path

# Decision: only names deploy.yml or smoke-test.sh would fail without. Summary-only values
# (ApiFunctionName, distribution_domain, site_url) are optional there, so they are not checked.
SAM_PARAMETERS = ["GitSha"]
SAM_OUTPUTS = ["HttpApiUrl"]
TERRAFORM_OUTPUTS = ["web_bucket_name", "distribution_id"]
# The GitSha parameter must reach the function as GIT_SHA (services/api/src/config.ts), or the
# health check can never report the deployed commit.
GIT_SHA_ENV = re.compile(r"GIT_SHA:[^\n]*GitSha|GIT_SHA:[ \t]*\n[ \t]+(Ref|!Ref):?[ \t]*GitSha")


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


def check_sam(root: Path) -> list[str]:
    path = root / "infra/sam/template.yaml"
    if not path.is_file():
        return [f"{path} is missing"]
    template = path.read_text(encoding="utf-8")
    errors = []
    for section, wanted in (("Parameters", SAM_PARAMETERS), ("Outputs", SAM_OUTPUTS)):
        missing = sorted(set(wanted) - section_keys(template, section))
        if missing:
            errors.append(f"{path}: {section} is missing {', '.join(missing)}")
    if not GIT_SHA_ENV.search(template):
        errors.append(f"{path}: no function environment variable GIT_SHA set from GitSha")
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
    print("Infra provides every name deploy.yml relies on.")


if __name__ == "__main__":
    main()
