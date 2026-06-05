# AGENTS.md

Source of truth for agent instructions. `CLAUDE.md` and `GEMINI.md` are symlinks to this file.

## Project Overview

**pjangler** - DeLoNET project bootstrapper

## Ticket Management (MANDATORY)

No code changes without an active Plane ticket. The board binding is the
`ticket_provider` block in `.project.json` (the single source of truth); the
PM agent owns it and the Scrum Master (Ticket Sentinel) watches the same board.

```
Board:  pjangler (PJAN)
Plane:  https://plane.delo.sh/33god/projects/18a79832-00fb-4146-b054-d88528f9fef3/issues/
```

- Move ticket to "In Progress" before first code change
- Branch names must include ticket reference
- Commit messages must reference tickets
- Emergency bypass: `ALLOW_NO_TICKET=1`

## Development

```bash
# Load environment
mise trust

# Run tasks
mise tasks  # list available tasks
mise run setup  # initial setup
```

## BMAD Methodology

This project follows BMAD. All methodology files are in `_bmad/`.

- Strict BMAD adherence for prompts and tasks
- Component work delegated to specialized agents
- Maintain parity between BMAD documents and Plane boards

## Principles

- Work with full autonomy toward task goals
- Make well-informed decisions when judgment calls arise
- Speed prioritized over perfection for non-critical paths
