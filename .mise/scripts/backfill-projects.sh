#!/usr/bin/env bash
# backfill-projects.sh — discover every git repo under a root directory and
# register each one as a formal pjangler project.
#
# "Register" here means: ensure the canonical `.project.json` (the formal-project
# SOT, parity rule `sot.project-json`) exists and is normalized for the repo.
# With --plane it additionally creates/links the project in the 33god Plane
# workspace (an outward-facing cloud write) via setup-plane.py.
#
# Usage:
#   mise run projects:backfill -- <root-dir> [options]
#
#   <root-dir>        Directory to scan for git repos (e.g. /home/delorenj/code).
#
# Options:
#   --apply           Actually register. Without it the task is a DRY RUN that
#                     only reports what it found and what it would do.
#   --plane           Also register each project in Plane (implies a cloud write;
#                     needs PLANE_33GOD_API_KEY, otherwise a placeholder is
#                     written). Only meaningful with --apply.
#   --full            Register via the full parity migration (`migrate --all`)
#                     instead of only the `.project.json` rule.
#   --depth N         Max directory depth to scan (default: unlimited).
#   -h, --help        Show this help.
#
# Discovery skips node_modules/.venv/.cache and treats nested repos (e.g.
# submodules living under an already-discovered project) as part of the parent.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
REGISTER_RULE="sot.project-json"

ROOT=""
APPLY=0
PLANE=0
FULL=0
DEPTH=""

# Print the leading comment block (line 2 up to the first non-comment line) as
# help, stripping the leading "# ". Pattern-based so it tracks header edits.
usage() { sed -n '2,/^[^#]/{/^#/s/^# \{0,1\}//p;}' "${BASH_SOURCE[0]}"; }

while [[ $# -gt 0 ]]; do
  case "$1" in
    --apply) APPLY=1; shift ;;
    --plane) PLANE=1; shift ;;
    --full)  FULL=1; shift ;;
    --depth)
      if [[ $# -lt 2 ]]; then
        echo "backfill-projects: --depth requires an argument" >&2; exit 2
      fi
      if [[ ! "$2" =~ ^[0-9]+$ ]]; then
        echo "backfill-projects: --depth must be a non-negative integer: $2" >&2; exit 2
      fi
      DEPTH="$2"; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    --) shift ;;
    -*) echo "backfill-projects: unknown option: $1" >&2; usage; exit 2 ;;
    *)
      if [[ -z "$ROOT" ]]; then ROOT="$1"; else
        echo "backfill-projects: unexpected argument: $1" >&2; exit 2
      fi
      shift ;;
  esac
done

if [[ -z "$ROOT" ]]; then
  echo "backfill-projects: a root directory is required" >&2
  echo "  e.g. mise run projects:backfill -- /home/delorenj/code" >&2
  exit 2
fi
if [[ ! -d "$ROOT" ]]; then
  echo "backfill-projects: not a directory: $ROOT" >&2
  exit 2
fi
ROOT="$(cd "$ROOT" && pwd)"

# Fail fast on Plane prerequisites rather than after scanning/registering.
if [[ $PLANE -eq 1 ]]; then
  if ! command -v python3 >/dev/null 2>&1; then
    echo "backfill-projects: python3 is required for --plane" >&2; exit 2
  fi
  if [[ ! -f "$SCRIPT_DIR/setup-plane.py" ]]; then
    echo "backfill-projects: setup-plane.py not found in $SCRIPT_DIR" >&2; exit 2
  fi
fi

# --- Resolve how to invoke the pjangler CLI -------------------------------
# The dist bundle externalizes deps, so it only runs with node_modules present;
# otherwise fall back to bun running the TypeScript source directly.
if command -v pjangler >/dev/null 2>&1; then
  PJ=(pjangler)
elif [[ -f "$REPO_ROOT/dist/index.js" && -d "$REPO_ROOT/node_modules" ]]; then
  PJ=(node "$REPO_ROOT/dist/index.js")
elif command -v bun >/dev/null 2>&1 && [[ -f "$REPO_ROOT/src/index.ts" ]]; then
  PJ=(bun run "$REPO_ROOT/src/index.ts")
elif [[ -f "$REPO_ROOT/dist/index.js" ]]; then
  PJ=(node "$REPO_ROOT/dist/index.js")
else
  echo "backfill-projects: could not find a way to run pjangler (no 'pjangler'" >&2
  echo "  on PATH, no runnable dist/index.js, no bun). Run 'mise run build' first." >&2
  exit 1
fi

# --- Discover git repos ---------------------------------------------------
declare -a find_args=("$ROOT")
[[ -n "$DEPTH" ]] && find_args+=(-maxdepth "$DEPTH")
find_args+=(
  -type d \( -name node_modules -o -name .venv -o -name .cache \) -prune -o
  -name .git -print
)

mapfile -t raw < <(find "${find_args[@]}" 2>/dev/null | sed 's#/\.git$##' | sort -u)

# Drop nested repos (a repo whose path lives under another discovered repo —
# typically a submodule; it registers as part of its parent).
declare -a repos=()
for d in "${raw[@]}"; do
  [[ -z "$d" ]] && continue
  nested=0
  for p in "${raw[@]}"; do
    if [[ "$d" != "$p" && "$d" == "$p"/* ]]; then nested=1; break; fi
  done
  [[ $nested -eq 0 ]] && repos+=("$d")
done

if [[ ${#repos[@]} -eq 0 ]]; then
  echo "No git repos found under $ROOT"
  exit 0
fi

mode="DRY RUN (nothing written) — pass --apply to register"
[[ $APPLY -eq 1 ]] && mode="APPLY"
rule_label="$REGISTER_RULE"
[[ $FULL -eq 1 ]] && rule_label="all parity rules (--full)"

# --plane only takes effect with --apply; be explicit rather than silently
# reporting "plane: yes" and then doing nothing.
plane_label="no"
if [[ $PLANE -eq 1 ]]; then
  if [[ $APPLY -eq 1 ]]; then
    plane_label="yes"
  else
    plane_label="requested (no effect without --apply)"
    echo "backfill-projects: note: --plane is ignored without --apply; no Plane changes will be made." >&2
  fi
fi

echo "pjangler backfill"
echo "  root:     $ROOT"
echo "  repos:    ${#repos[@]}"
echo "  register: $rule_label"
echo "  plane:    $plane_label"
echo "  mode:     $mode"
echo

register_one() {
  local repo="$1"
  if [[ $FULL -eq 1 ]]; then
    "${PJ[@]}" migrate --all "$repo"
  else
    "${PJ[@]}" migrate "$REGISTER_RULE" "$repo"
  fi
}

preview_one() {
  local repo="$1"
  if [[ $FULL -eq 1 ]]; then
    "${PJ[@]}" migrate --all "$repo" --dry-run || true
  else
    "${PJ[@]}" migrate "$REGISTER_RULE" "$repo" --dry-run || true
  fi
}

fail=0
for repo in "${repos[@]}"; do
  name="$(basename "$repo")"
  echo "── $name  ($repo)"
  if [[ $APPLY -eq 1 ]]; then
    if register_one "$repo"; then
      if [[ $PLANE -eq 1 ]]; then
        echo "   plane: registering…"
        ( cd "$repo" && python3 "$SCRIPT_DIR/setup-plane.py" ) || {
          echo "   plane: FAILED for $name" >&2; fail=1;
        }
      fi
    else
      echo "   register: FAILED for $name" >&2; fail=1
    fi
  else
    preview_one "$repo"
  fi
  echo
done

if [[ $APPLY -eq 0 ]]; then
  if [[ $PLANE -eq 1 ]]; then
    echo "Dry run complete. Re-run with --apply to register (Plane registration will run too)."
  else
    echo "Dry run complete. Re-run with --apply to register (add --plane to also register in Plane)."
  fi
fi
exit $fail
