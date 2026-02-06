import type { InvokeResult } from "./Command";
import { Command } from "./Command";

export class AddMiseConsoleScript extends Command {
  async invoke(): Promise<InvokeResult> {
    const filePath = ".mise/tasks/console.py";

    if (this.fileExists(filePath) && !this.context.force) {
      return {
        success: false,
        message: this.formatMessage("⚠️  .mise/tasks/console.py already exists"),
        filePath,
      };
    }

    const content = `#!/usr/bin/env python3
"""Generic manifest-driven mise task dispatcher.

Task patterns:
- component:list
- component:run -- <component> <task> [-- args]
- <component>:<task> delegated via MISE_TASK_NAME + console.py delegate
"""

from __future__ import annotations

import os
import shlex
import subprocess
import sys
from pathlib import Path

try:
    import tomllib
except Exception as exc:  # pragma: no cover
    raise SystemExit(f"python tomllib unavailable: {exc}")

ROOT = Path(__file__).resolve().parents[2]
MANIFEST = ROOT / "components.toml"


def load_components() -> dict[str, dict]:
    if not MANIFEST.exists():
        raise SystemExit(f"manifest not found: {MANIFEST}")
    data = tomllib.loads(MANIFEST.read_text())
    comps = data.get("components", {})
    if not isinstance(comps, dict):
        raise SystemExit("components.toml: [components] table missing or invalid")
    return comps


def resolve_component(name: str, comps: dict[str, dict]) -> Path:
    if name not in comps:
        raise SystemExit(f"unknown component '{name}'.")
    cfg = comps[name] or {}
    if cfg.get("enabled", True) is False:
        raise SystemExit(f"component '{name}' is disabled")
    rel_path = cfg.get("path", name)
    path = (ROOT / rel_path).resolve()
    if not path.exists():
        raise SystemExit(f"component path missing for '{name}': {path}")
    return path


def run(cmd: list[str]) -> int:
    print(f"[console.py] {' '.join(shlex.quote(c) for c in cmd)}")
    return subprocess.call(cmd, cwd=ROOT)


def cmd_list() -> int:
    comps = load_components()
    print("component\tpath\tkind\tenabled")
    for name, cfg in sorted(comps.items(), key=lambda x: x[0].lower()):
        print(
            f"{name}\t{cfg.get('path', name)}\t{cfg.get('kind', 'unknown')}\t{cfg.get('enabled', True)}"
        )
    return 0


def cmd_run(argv: list[str]) -> int:
    if len(argv) < 2:
        raise SystemExit("usage: console.py run <component> <task> [-- <args...>]")

    component = argv[0]
    task = argv[1]
    extra = argv[2:]
    if extra and extra[0] == "--":
        extra = extra[1:]

    comps = load_components()
    path = resolve_component(component, comps)

    cmd = ["mise", "-C", str(path), "run", task]
    if extra:
        cmd.extend(["--", *extra])
    return run(cmd)


def cmd_delegate(argv: list[str]) -> int:
    task_name = os.environ.get("MISE_TASK_NAME", "")
    if ":" not in task_name:
        raise SystemExit("delegate requires MISE_TASK_NAME like '<component>:<task>'")

    component, task = task_name.split(":", 1)
    comps = load_components()
    path = resolve_component(component, comps)

    cmd = ["mise", "-C", str(path), "run", task]
    if argv:
        if argv[0] == "--":
            argv = argv[1:]
        if argv:
            cmd.extend(["--", *argv])
    return run(cmd)


def main() -> int:
    if len(sys.argv) < 2:
        raise SystemExit("usage: console.py <list|run|delegate> ...")

    sub = sys.argv[1]
    argv = sys.argv[2:]

    if sub == "list":
        return cmd_list()
    if sub == "run":
        return cmd_run(argv)
    if sub == "delegate":
        return cmd_delegate(argv)

    raise SystemExit(f"unknown subcommand: {sub}")


if __name__ == "__main__":
    raise SystemExit(main())
`;

    this.writeFile(filePath, content);
    return {
      success: true,
      message: this.formatMessage(
        this.context.dryRun
          ? "Would create .mise/tasks/console.py"
          : "✅ Created .mise/tasks/console.py",
      ),
      filePath,
    };
  }
}
