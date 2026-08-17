The new project registry flow can leave `.project.json` out of sync with the registry and can erase existing agent records when adding another role. These are functional data-consistency regressions that should be fixed before the patch is considered correct.

Full review comments:

- [P2] Update existing manifests during sync — /home/delorenj/code/pjangler/src/index.ts:189-189
  When syncing a repo that already has `.project.json`, this returns false solely because the file exists, so `project.write-manifest` is not selected even if the planned name, description, slug, identifier, or agents differ. The audit path only verifies shape/presence for many of those fields, so `pjangler project init --apply --yes --description ... --identifier ...` can update the central registry while leaving the repo-local projection stale.

- [P2] Merge new agents into existing registry entries — /home/delorenj/code/pjangler/src/project/index.ts:291-298
  When `--provision-agent` is used for an already registered project, this branch replaces `existing?.agents` with a one-entry map for the requested role. Running project init later to add a `review` or `dev` agent would drop the existing `pm` agent from the registry and generated manifest instead of preserving it.

## Adversarial review

  Target: src/mcp-server.ts:23 at cb8402f8de47a023fb4ebf4a32ccb958f5fdf5a3
  Content class: TypeScript MCP server
  Lens: adversarial
  Context warning: file:{project-root}/**/project-context.md matched no files.

  The MCP baseline used here: tool results support isError, typed outputSchema/structuredContent, and behavioral
  annotations; stdio reserves stdout exclusively for MCP messages. MCP tools specification
  (<https://modelcontextprotocol.io/specification/2025-11-25/server/tools>), transport specification
  (<https://modelcontextprotocol.io/specification/2025-11-25/basic/transports>), TypeScript SDK guide
  (<https://github.com/modelcontextprotocol/typescript-sdk/blob/v1.x/docs/server.md>).

### Findings

  1. Silent unknown arguments can become writes

     Location: src/mcp-server.ts:492
     Trigger: Call pjangler_run_recipe with the plausible typo dryrun: true.
     Guard: Reject unknown properties and require an explicit apply signal for mutation.
     Consequence: The typo is stripped, dryRun defaults to false, and the recipe writes. A scratch probe created
     package.json, README.md, and src/.

  2. Generic recipe execution is write-by-default

     Location: src/mcp-server.ts:487
     Trigger: Omit dryRun and targetDir.
     Guard: Default to dry-run and require an explicit target plus apply: true.
     Consequence: The selected recipe mutates the MCP server’s current working directory.

  3. The generic endpoint exposes an interactive recipe

     Location: src/mcp-server.ts:493, src/commands/hermes/PromptForAgentConfig.ts:66
     Trigger: Invoke pjangler_run_recipe with recipe: "hermes-agent".
     Guard: Exclude interactive recipes from the generic endpoint or force a complete non-interactive context.
     Consequence: Clack may read the stdio transport’s stdin, hanging the request or consuming JSON-RPC traffic.

  4. Hermes output can corrupt the stdio stream

     Location: src/commands/hermes/PrintHermesSummary.ts:43, src/mcp-server.ts:620
     Trigger: A Hermes path reaches Clack output while quiet is unset, or enters its interactive prompt path.
     Guard: Force quiet mode for MCP execution and route diagnostics exclusively to stderr or captured result
     content.
     Consequence: Non-MCP output can appear on stdout, invalidating the stdio JSON-RPC stream.

  5. Hermes deployment has unsafe effect gates

     Location: src/mcp-server.ts:560
     Trigger: A minimal call omits dryRun, or sets local: false without explicit skip values.
     Guard: Default to dry-run; require apply: true, live: true, and explicit opt-ins for external effects.
     Consequence: The minimal call provisions locally, while local: false arms runtime-repository, Plane, and systemd
     work without a live/confirmation gate.

  6. Slug and role values can escape their intended directories

     Location: src/mcp-server.ts:270, src/project/index.ts:636, src/commands/hermes/RunCopierTemplate.ts:68
     Trigger: Supply values such as projectSlug: "../escaped" or agentRole: "../../escaped-role".
     Guard: Validate both as single safe path segments and verify resolved containment.
     Consequence: Project or agent files can be created outside the requested parent/project tree. The escape was
     reproduced in dry-run output.

  7. skipPlane does not suppress the project-plan board action

     Location: src/mcp-server.ts:285, src/project/index.ts:797
     Trigger: Call bootstrap with live: true, skipPlane: true.
     Guard: Propagate skipPlane into planning and require enabled = live && !skipPlane.
     Consequence: The returned plan still enables board creation/linking; the contradiction was reproduced by probe.

  8. boardUrl is accepted and discarded

     Location: src/mcp-server.ts:248, src/project/index.ts:751
     Trigger: Supply boardUrl to bootstrap or project initialization.
     Guard: Persist and validate it, or remove the unsupported field.
     Consequence: The manifest and ticket-provider record silently omit caller-supplied linkage metadata.

  9. skipBloodbank: false is a false contract

     Location: src/mcp-server.ts:582, src/commands/hermes/RunCopierTemplate.ts:113
     Trigger: Explicitly request skipBloodbank: false.
     Guard: Remove the parameter if Bloodbank is permanently fleet-shared, or make execution honor it.
     Consequence: The MCP response echoes false, but Copier always receives SKIP_BLOODBANK=1.

  10. Tool behavior annotations are absent

     Location: All 12 registrations beginning at src/mcp-server.ts:135
     Trigger: A client discovers tools and decides whether autonomous invocation is appropriate.
     Guard: Add accurate readOnlyHint, destructiveHint, idempotentHint, and openWorldHint annotations.
     Consequence: Clients receive no behavioral hints distinguishing inspection from filesystem or external-system
     mutation.

  11. Results have no typed output contract

     Location: src/mcp-server.ts:56
     Trigger: A client needs to consume project plans, registry records, audit reports, or deployment results.
     Guard: Declare outputSchema and return matching structuredContent alongside human-readable text.
     Consequence: Every structured result becomes JSON embedded in text, preventing SDK validation and encouraging
     brittle parsing.

  12. Some lifecycle failures are returned as successful tool calls

     Location: src/mcp-server.ts:329, src/mcp-server.ts:394
     Trigger: executeRegisteredProjectPlan returns ok: false without throwing.
     Guard: Map failed lifecycle results to isError: true consistently.
     Consequence: MCP clients may treat a failed or partially completed operation as a normal successful result.

  13. Collection and log responses are unbounded

     Location: src/mcp-server.ts:405, src/mcp-server.ts:508
     Trigger: A large registry, audit report, or verbose recipe produces extensive output.
     Guard: Add cursor/limit controls, response-size caps, and truncation metadata.
     Consequence: One tool call can consume excessive memory, transport bandwidth, and model context.

  14. Cancellation and subprocess timeouts are not propagated

     Location: src/mcp-server.ts:118, src/commands/hermes/RunCopierTemplate.ts:75
     Trigger: A client cancels during Copier, provisioning, or external commands.
     Guard: Propagate the handler abort signal, use cancellable subprocesses, and enforce timeouts with cleanup.
     Consequence: Work can continue mutating local or external state after the client has abandoned the request.

### Verification

  npm run typecheck and the three MCP regression suites passed:

- tests/mcp-server-regressions.mjs
- tests/mcp-catalog-regressions.mjs
- tests/pjan-65-regressions.mjs

  Those suites do not cover the contract failures above. Focused scratch probes reproduced unknown-key writes, both
  path escapes, the skipPlane contradiction, discarded boardUrl, and the local:false effect defaults.

  No repository files were changed. main is clean and synchronized with origin/main; the mandatory machine-wide git
  unpushed sweep reported unrelated pre-existing work elsewhere under ~/code.

### JSON

  [
    {
      "lens": "adversarial",
      "finding": "Silent unknown arguments can become writes",
      "location": "src/mcp-server.ts:492-505",
      "trigger": "Send dryrun=true instead of dryRun=true.",
      "guard": "Reject unknown properties and require an explicit apply signal.",
      "consequence": "The typo is stripped, dryRun defaults false, and the recipe writes."
    },
    {
      "lens": "adversarial",
      "finding": "Generic recipe execution is write-by-default",
      "location": "src/mcp-server.ts:487-508",
      "trigger": "Omit dryRun and targetDir.",
      "guard": "Default to dry-run and require an explicit target plus apply=true.",
      "consequence": "The recipe mutates the MCP server current working directory."
    },
    {
      "lens": "adversarial",
      "finding": "The generic endpoint exposes an interactive recipe",
      "location": "src/mcp-server.ts:493; src/commands/hermes/PromptForAgentConfig.ts:66-89",
      "trigger": "Run the hermes-agent recipe through pjangler_run_recipe.",
      "guard": "Exclude interactive recipes or force a complete non-interactive context.",
      "consequence": "Prompt code may block on or consume the JSON-RPC stdin stream."
    },
    {
      "lens": "adversarial",
      "finding": "Hermes output can corrupt the stdio stream",
      "location": "src/commands/hermes/PrintHermesSummary.ts:43-45; src/mcp-server.ts:620-621",
      "trigger": "Reach Clack output while quiet is unset or enter an interactive prompt.",
      "guard": "Force quiet mode and route diagnostics to stderr or captured result content.",
      "consequence": "Non-MCP stdout invalidates the stdio JSON-RPC stream."
    },
    {
      "lens": "adversarial",
      "finding": "Hermes deployment has unsafe effect gates",
      "location": "src/mcp-server.ts:560-583",
      "trigger": "Omit dryRun or set local=false without explicit skip values.",
      "guard": "Default to dry-run and require apply, live, and explicit external-effect opt-ins.",
      "consequence": "Local mutation is the default and local=false arms external provisioning."
    },
    {
      "lens": "adversarial",
      "finding": "Slug and role values can escape intended directories",
      "location": "src/mcp-server.ts:270-273; src/project/index.ts:636-637; src/commands/hermes/
      RunCopierTemplate.ts:68",
      "trigger": "Use parent-directory components in projectSlug or agentRole.",
      "guard": "Validate safe path segments and verify resolved containment.",
      "consequence": "Project or agent files can be created outside the intended tree."
    },
    {
      "lens": "adversarial",
      "finding": "skipPlane does not suppress the board action",
      "location": "src/mcp-server.ts:277-306; src/project/index.ts:797-815",
      "trigger": "Bootstrap with live=true and skipPlane=true.",
      "guard": "Propagate skipPlane and enable the action only when live and not skipped.",
      "consequence": "Board creation or linking remains enabled despite the caller's skip request."
    },
    {
      "lens": "adversarial",
      "finding": "boardUrl is accepted and discarded",
      "location": "src/mcp-server.ts:248,300,364,386; src/project/index.ts:751-759",
      "trigger": "Supply boardUrl during bootstrap or project initialization.",
      "guard": "Persist and validate the URL or remove the field.",
      "consequence": "Caller-supplied board linkage metadata silently disappears."
    },
    {
      "lens": "adversarial",
      "finding": "skipBloodbank false is a false contract",
      "location": "src/mcp-server.ts:552,582,604; src/commands/hermes/RunCopierTemplate.ts:113-117",
      "trigger": "Explicitly set skipBloodbank=false.",
      "guard": "Remove the option or make execution honor it.",
      "consequence": "The response reports false while Copier always receives SKIP_BLOODBANK=1."
    },
    {
      "lens": "adversarial",
      "finding": "Tool behavior annotations are absent",
      "location": "src/mcp-server.ts:135-618",
      "trigger": "A client assesses whether a discovered tool is safe to invoke autonomously.",
      "guard": "Declare accurate read-only, destructive, idempotent, and open-world hints.",
      "consequence": "Clients cannot distinguish inspection from local or external mutation."
    },
    {
      "lens": "adversarial",
      "finding": "Results have no typed output contract",
      "location": "src/mcp-server.ts:56-58",
      "trigger": "A client consumes a structured result.",
      "guard": "Declare outputSchema and return matching structuredContent.",
      "consequence": "Structured data is embedded in text without SDK validation."
    },
    {
      "lens": "adversarial",
      "finding": "Lifecycle failures can be returned as successful calls",
      "location": "src/mcp-server.ts:329,394-398",
      "trigger": "Project execution returns ok=false without throwing.",
      "guard": "Return isError=true for every failed lifecycle result.",
      "consequence": "Clients may treat failed or partial execution as success."
    },
    {
      "lens": "adversarial",
      "finding": "Collection and log responses are unbounded",
      "location": "src/mcp-server.ts:405-433,508-517",
      "trigger": "Use a large registry or generate verbose recipe output.",
      "guard": "Add pagination, response caps, and explicit truncation metadata.",
      "consequence": "A single result can exhaust transport and model context budgets."
    },
    {
      "lens": "adversarial",
      "finding": "Cancellation and subprocess timeouts are not propagated",
      "location": "src/mcp-server.ts:118-132; src/commands/hermes/RunCopierTemplate.ts:75",
      "trigger": "Cancel a long-running provisioning or Copier operation.",
      "guard": "Propagate abort signals and enforce subprocess timeouts with cleanup.",
      "consequence": "Mutation can continue after the client abandons the request."
    }
  ]
