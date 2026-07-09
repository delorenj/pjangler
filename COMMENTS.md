The changes introduce provider-agnostic ticket configuration, but non-Plane paths still emit Plane-specific URLs and PM instructions. Those issues can misroute generated projects or agents for Linear/Trello configurations.

Full review comments:

- [P2] Don't mint Plane URLs for Linear providers — /home/delorenj/code/pjangler/src/project/index.ts:265-271
  When `--ticket-provider linear --board-id ...` is used, this non-Trello branch writes a `ticket_provider` with `type: "linear"` but a `board_url` under `https://plane.delo.sh/...`, so consumers that open the registry or `.project.json` board URL will be routed to the wrong provider. Either avoid advertising Linear here or require/use a Linear-specific URL for that provider.

- [P2] Guard Plane-only PM guidance by provider — /home/delorenj/code/pjangler/templates/hermes-agent/template/SOUL.md.jinja:58-63
  When this template is rendered for a non-Plane PM (`ticket_provider=trello` or `linear`), the unguarded Plane wording becomes part of `SOUL.md` and contradicts the configured adapter, so the PM is told to decompose work on Plane instead of the selected provider. The sentinel prompt already gates this guidance on `ticket_provider == "plane"`; this template should be guarded or provider-neutral too.

## instructions

1. Remove linear as an option. Only support Plane and Trello for now.
2. Make sure the guidance throughout the CommonProject/pjangler/hermes-agent templates are ticket-provider agnostic.
