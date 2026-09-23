"""Read the deploy settings the workflow needs from samconfig.toml.

Usage:
  python3 read-samconfig.py stack-name [samconfig.toml] [config-env]
  python3 read-samconfig.py overrides  [samconfig.toml] [config-env]

stack-name prints the stack name, so the workflow and a local `sam deploy` always target the same
stack (samconfig is the single source of truth). It exits non-zero when none is set, which stops
the deploy before anything changes.

overrides prints samconfig's parameter_overrides, one entry per line. sam deploy drops them
entirely when --parameter-overrides is also given on the command line, so the workflow passes
these through and appends GitSha=<sha>, which wins because the SAM CLI applies overrides in order.
"""

import re
import sys

try:
    import tomllib
except ModuleNotFoundError:  # Python < 3.11 (for example macOS /usr/bin/python3)
    sys.exit("read-samconfig.py needs Python 3.11 or newer (tomllib)")

# Decision: same rule CloudFormation applies to stack names, checked here so a malformed value
# fails before any AWS call.
STACK_NAME = re.compile(r"^[A-Za-z][A-Za-z0-9-]{0,127}$")


def read_parameter(path: str, config_env: str, key: str):
    with open(path, "rb") as handle:
        config = tomllib.load(handle).get(config_env, {})
    # Same precedence as the SAM CLI: the command section first, then the global section.
    for section in ("deploy", "global"):
        parameters = config.get(section, {}).get("parameters", {})
        if key in parameters:
            return parameters[key]
    return None


def stack_name(path: str, config_env: str) -> list[str]:
    value = read_parameter(path, config_env, "stack_name")
    if not isinstance(value, str) or not STACK_NAME.match(value):
        sys.exit(f"{path}: [{config_env}.deploy.parameters] needs a valid stack_name")
    return [value]


def overrides(path: str, config_env: str) -> list[str]:
    value = read_parameter(path, config_env, "parameter_overrides")
    if value is None:
        return []
    entries = [value] if isinstance(value, str) else [str(item) for item in value]
    for entry in entries:
        if "\n" in entry:
            sys.exit("parameter_overrides entries must be single-line")
    return entries


def main() -> None:
    modes = {"stack-name": stack_name, "overrides": overrides}
    if len(sys.argv) < 2 or sys.argv[1] not in modes:
        sys.exit(__doc__)
    path = sys.argv[2] if len(sys.argv) > 2 else "samconfig.toml"
    config_env = sys.argv[3] if len(sys.argv) > 3 else "default"
    for line in modes[sys.argv[1]](path, config_env):
        print(line)


if __name__ == "__main__":
    main()
