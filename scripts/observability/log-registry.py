#!/usr/bin/env python3
"""The OpenBot runtime log event registry, generated from the source call sites.

Every structured runtime log line the first-phase services emit is
`console.<level>(JSON.stringify({ type: "<name>", ... }))`. The collector only
lets a line into OpenObserve with a fixed event name and the severity of the
call that wrote it, so the registry has to follow the sources: a name or a
level that drifted from the real call site would misfile real records exactly
the way this ticket was once rejected for (a real Warn arriving as an Error,
normal business events arriving as an unclassified summary).

This script scans the call sites and rewrites the generated block in
`docker/observability/otel-collector.yaml`:

    python3 scripts/observability/log-registry.py           # rewrite the block
    python3 scripts/observability/log-registry.py --check   # verify it is current

`--check` is the regression gate: any source change that adds, renames or
re-levels an event without regenerating the block fails here.

Lines that carry no literal event name (dynamic `{ type, ... }` shorthand) and
lines that are plain text cannot be enumerated this way. The collector stores
them as the fixed `runtime-unclassified` summary with an explicitly Unknown
severity — never an invented level — and the runbook lists them as the known
parsing gap. Text events whose wording IS stable are pinned by hand in the
collector config; each pinned template's literal must be found in the scanned
sources, and this script fails if one stops matching.
"""

from __future__ import annotations

import argparse
import re
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
COLLECTOR = REPO / "docker/observability/otel-collector.yaml"

# The first-phase services, as the collector's tag whitelist names them.
SERVICES = {
    "server": "server/src",
    "worker": "worker/src",
    "supervisor": "supervisor/src",
    "agent-bot": "agent-bot/src",
    "agent-langgraph": "agent-langgraph/src",
    "agent-computer": "agent-computer/src",
}

# Names the source writes at two different levels, resolved by hand to the
# level the runtime stream should carry. Anything else that appears at mixed
# levels is a registry bug and fails the run.
OVERRIDES: dict[str, str] = {}

# Text lines with stable wording, pinned by hand. Each entry:
# (event name in OpenObserve, severity, needle that must exist in the named
# service's sources). The needle is matched literally so a reworded template
# fails this script instead of silently going unclassified.
PINNED_TEMPLATES = [
    ("server-listening", "Info", "server", "OpenBot server listening on "),
    ("bot-handoff-sweep-failed", "Warn", "server", "[handoff] a sweep could not run:"),
    ("worker-status", "Info", "worker", "OpenBot worker status: "),
    ("agent-listening", "Info", "agent-bot", " listening on "),
    ("agent-listening", "Info", "agent-langgraph", " listening on "),
    ("agent-listening", "Info", "agent-computer", " listening on "),
]

BEGIN = "# BEGIN GENERATED LOG REGISTRY"
END = "# END GENERATED LOG REGISTRY"

LEVEL_OF = {"log": "Info", "info": "Info", "warn": "Warn", "error": "Error"}
RANK = {"Info": 0, "Warn": 1, "Error": 2}


def console_calls(text: str):
    """Yield (level, statement text) for every console.<level>(...) call site.

    The statement spans balanced parentheses, so a nested JSON.stringify or a
    multi-line template contributes its whole statement and nothing of the next
    one. String literals and comments inside the statement are skipped when
    matching `type: "..."`, so an AG-UI payload's `type:` cannot leak in.
    """
    for match in re.finditer(r"console\.(log|info|warn|error)\(", text):
        level = LEVEL_OF[match.group(1)]
        depth, index = 0, match.end() - 1
        while index < len(text):
            char = text[index]
            if char == "(":
                depth += 1
            elif char == ")":
                depth -= 1
                if depth == 0:
                    break
            elif char == '"':
                index = text.find('"', index + 1)
            elif char == "'":
                index = text.find("'", index + 1)
            elif char == "`":
                index = text.find("`", index + 1)
            elif text[index : index + 2] == "//":
                index = text.find("\n", index)
            index += 1
        yield level, text[match.start() : index + 1], text[: match.start()].count("\n") + 1


def scan():
    """Collect event name -> level -> call sites across the first-phase services."""
    registry: dict[str, dict[str, list[str]]] = {}
    for service, root in SERVICES.items():
        for path in sorted((REPO / root).rglob("*.ts")):
            text = path.read_text(errors="ignore")
            for level, statement, line in console_calls(text):
                cleaned = re.sub(r"//[^\n]*", "", statement)
                for name in re.findall(r'\btype: "([a-z0-9][a-z0-9-]*)"', cleaned):
                    registry.setdefault(name, {}).setdefault(level, []).append(
                        f"{service}:{path.relative_to(REPO)}:{line}"
                    )
    return registry


def resolve(registry):
    """Flatten to name -> level, failing on a mixed-level name without an override."""
    resolved, conflicts = {}, []
    for name, levels in registry.items():
        if len(levels) == 1:
            resolved[name] = next(iter(levels))
            continue
        override = OVERRIDES.get(name)
        if override in levels:
            resolved[name] = override
        else:
            conflicts.append(
                f"{name}: " + ", ".join(f"{level} at {sites[0]}" for level, sites in sorted(levels.items()))
            )
    if conflicts:
        raise SystemExit(
            "event names emitted at more than one level (resolve in OVERRIDES):\n  "
            + "\n  ".join(sorted(conflicts))
        )
    return resolved


def check_pinned_templates():
    missing = []
    for name, _severity, service, needle in PINNED_TEMPLATES:
        root = REPO / SERVICES[service]
        if not any(needle in path.read_text(errors="ignore") for path in root.rglob("*.ts")):
            missing.append(f"{name}: {needle!r} not found in {service}")
    if missing:
        raise SystemExit("pinned text templates no longer match the sources:\n  " + "\n  ".join(missing))


def statement(kind: str, names: list[str]) -> str:
    pattern = "^(" + "|".join(sorted(names)) + ")$"
    if kind == "recognise":
        return (
            '- set(attributes["openbot.log_type"], cache["data"]["type"]) '
            'where IsString(cache["data"]["type"]) and IsMatch(cache["data"]["type"], '
            f'"{pattern}")'
        )
    level = kind
    return (
        f'- set(severity_text, "{level}") where IsString(attributes["openbot.log_type"]) '
        'and IsMatch(attributes["openbot.log_type"], '
        f'"{pattern}")'
    )


def render(registry):
    names = sorted(registry)
    warns = sorted(n for n, level in registry.items() if level == "Warn")
    errors = sorted(n for n, level in registry.items() if level == "Error")
    indent = " " * 10
    lines = [
        indent + BEGIN,
        indent + f"# {len(names)} structured events, levels taken from their console call sites.",
        indent + "# Regenerate with `python3 scripts/observability/log-registry.py`; verify with --check.",
        indent + f"# Events: {len(names)}; Warn: {len(warns)}; Error: {len(errors)}; Info is the default.",
        indent + "      # fmt: the long alternations below are generated, not hand-wrapped.",
        indent + statement("recognise", names),
        indent + statement("Warn", warns),
        indent + statement("Error", errors),
        indent + END,
    ]
    return lines


def rewrite_block(rendered):
    text = COLLECTOR.read_text()
    start, end = block_span(text)
    COLLECTOR.write_text(text[:start] + "\n".join(rendered) + text[end:])


def block_span(text):
    """The generated block, from the start of its BEGIN line to the end of its END line."""
    begin_line = text.rfind("\n", 0, text.index(BEGIN)) + 1
    end_line = text.index(END)
    end = text.index("\n", end_line) if "\n" in text[end_line:] else len(text)
    return begin_line, end


def block_matches(rendered):
    text = COLLECTOR.read_text()
    start, end = block_span(text)
    return text[start:end] == "\n".join(rendered)


def main():
    argument_parser = argparse.ArgumentParser(description=__doc__)
    argument_parser.add_argument("--check", action="store_true", help="verify the generated block is current")
    arguments = argument_parser.parse_args()
    check_pinned_templates()
    registry = resolve(scan())
    rendered = render(registry)
    if arguments.check:
        if not block_matches(rendered):
            raise SystemExit(
                f"{COLLECTOR.relative_to(REPO)} registry block is stale; "
                "run `python3 scripts/observability/log-registry.py`"
            )
        print(f"registry current: {len(registry)} events")
        return
    rewrite_block(rendered)
    print(f"rewrote registry block: {len(registry)} events")


if __name__ == "__main__":
    main()
