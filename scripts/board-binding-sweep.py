#!/usr/bin/env python3
"""Read-only sweep: which Hermes roles have a usable ticket_provider board binding?

For every deployed role under ~/code, report the declared workspace (from
.project.json, the SOT, then role.yaml's legacy field) and then actually invoke
the role's own adapter with a pure-GET op. A 404 with an empty workspace is the
voxxy failure: the adapter builds a workspace-less URL and can never reach Plane.
Nothing is mutated; `resolve` and `describe_board` are reads.
"""
import json
import os
import re
import subprocess
import sys
from pathlib import Path

CODE = Path("/home/delorenj/code")


def project_json_workspace(repo: Path):
    f = repo / ".project.json"
    if not f.is_file():
        return None, None
    try:
        tp = json.loads(f.read_text()).get("ticket_provider") or {}
    except Exception:
        return "<unparseable>", None
    return tp.get("workspace", ""), tp.get("type", "")


def role_yaml_workspace(role_dir: Path):
    f = role_dir / "role.yaml"
    if not f.is_file():
        return None
    text = f.read_text()
    m = re.search(r"(?ms)^ticket_provider:\s*$(.*?)(?=^\S)", text + "\n\x00")
    if not m:
        return None
    mm = re.search(r'(?m)^\s*workspace:\s*"?([^"\n]*)"?\s*$', m.group(1))
    return mm.group(1).strip() if mm else None


def probe(role_dir: Path, provider: str) -> str:
    """Invoke the role's own adapter with a read-only op."""
    script = role_dir / ".scripts" / "providers" / f"{provider}.sh"
    if not script.is_file():
        return "no-adapter"
    env = dict(os.environ)
    # Mirror what the fleet injects, so the probe isolates the BINDING, not the key.
    for candidate in ("PLANE_33GOD_API_KEY", "PLANE_AUTOMATICAI_API_KEY"):
        if os.environ.get(candidate):
            env.setdefault("PLANE_API_KEY", os.environ[candidate])
            break
    try:
        p = subprocess.run(["sh", str(script), "resolve"], cwd=str(role_dir),
                           capture_output=True, text=True, timeout=45, env=env)
    except subprocess.TimeoutExpired:
        return "timeout"
    if p.returncode == 0:
        try:
            d = json.loads(p.stdout.strip().splitlines()[-1])
            return f"OK {d.get('identifier', '?')}"
        except Exception:
            return "OK (unparseable)"
    err = (p.stderr or p.stdout).strip().splitlines()
    first = err[0] if err else "unknown"
    if "404" in first:
        return "HTTP 404"
    if "API_KEY" in first:
        return "no-key"
    if "workspace not set" in first:
        return "workspace unset"
    return first[:44]


def main() -> int:
    rows = []
    for role_yaml in sorted(CODE.glob("*/agents/hermes/*/role.yaml")) + \
                     sorted(CODE.glob("*/*/agents/hermes/*/role.yaml")):
        role_dir = role_yaml.parent
        # repo root = the dir containing agents/
        repo = role_dir.parent.parent.parent
        pj_ws, provider = project_json_workspace(repo)
        ry_ws = role_yaml_workspace(role_dir)
        provider = provider or "plane"
        effective = pj_ws or ry_ws or ""
        rows.append({
            "repo": str(repo.relative_to(CODE)),
            "role": role_dir.name,
            "pj": pj_ws,
            "ry": ry_ws,
            "effective": effective,
            "status": probe(role_dir, provider),
        })

    print(f"{'REPO':<28} {'ROLE':<9} {'.project.json':<14} {'role.yaml':<12} PROBE")
    print("-" * 88)
    broken = []
    for r in rows:
        pj = "(missing)" if r["pj"] is None else (r["pj"] or "«empty»")
        ry = "(none)" if r["ry"] is None else (r["ry"] or "«empty»")
        print(f"{r['repo']:<28} {r['role']:<9} {pj:<14} {ry:<12} {r['status']}")
        if not r["effective"] or "404" in r["status"]:
            broken.append(r)

    print("-" * 88)
    print(f"{len(rows)} role(s) swept · {len(broken)} with an unusable binding")
    if broken:
        print("\nUNUSABLE (empty workspace and/or 404):")
        for r in broken:
            print(f"  {r['repo']}/{r['role']}  ->  {r['status']}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
