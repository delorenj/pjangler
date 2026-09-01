// The MCP half of the fleet observation surface.
//
// It lives here rather than in `src/mcp-server.ts` for one reason: the story's
// hard claim is that CLI and MCP are two THIN adapters over one core, adding
// envelope wrapping and `next_actions` guidance and nothing else -- no extra
// option, no different default, no alternate policy. That claim is only worth
// making if it is inspectable, and a reviewer can read this file end to end in a
// minute and see that every handler does exactly three things: shape arguments,
// call the shared core, wrap the result.
//
// `asText` is passed IN rather than imported. `src/mcp-server.ts` runs
// `await server.connect(new StdioServerTransport())` at module scope, so
// importing anything from it would start a server as a side effect of loading
// this module. Cloning the helper instead would give the tool surface two result
// shapes, which is the thing the shared helper exists to prevent.

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { collectFleetInventory } from "./inventory";
import {
  fleetFailureEnvelope,
  fleetSuccessEnvelope,
  normalizeFleetError,
  type FleetEnvelopeV1,
} from "./output";
import { collectFleetProvenance } from "./provenance";
import { createRunContext } from "./runtime";
import { FleetError, type FleetInventory, type FleetProvenance } from "./types";

const INVENTORY_COMMAND = "fleet.inventory";
const PROVENANCE_COMMAND = "fleet.provenance";

/**
 * The shared flag surface, one-for-one with the CLI's.
 *
 * `z.strictObject` matches the rest of the tool catalog: an unknown top-level
 * argument is rejected at the protocol boundary, before the handler can read any
 * state. A misspelled `deadline_ms` must fail loudly rather than be silently
 * dropped into an unbounded run.
 */
const FLEET_TOOL_INPUT = {
  agent: z.string().optional().describe("Report only this agent; totals and the verdict still describe the whole fleet."),
  projectRegistry: z.string().optional().describe("Inspect this project registry instead of the configured one. Never rewrites the configured path."),
  agentRegistry: z.string().optional().describe("Inspect this agent registry instead of the configured one."),
  contract: z.string().optional().describe("Validate and read this fleet contract instead of the tracked one."),
  deadlineMs: z.number().int().positive().optional().describe("Fail with TIMEOUT if the whole run has not finished within this budget."),
} as const;

interface FleetToolArgs {
  agent?: string;
  projectRegistry?: string;
  agentRegistry?: string;
  contract?: string;
  deadlineMs?: number;
}

/**
 * The CLI's `requireValue` guard, asked of an MCP argument.
 *
 * Zod already rejects a non-string, but not an empty or option-shaped one. The
 * CLI refuses both, and an adapter that accepted what its twin refuses would not
 * be the same command.
 */
function requireValue(value: string | undefined, flag: string): void {
  if (value === undefined) return;
  if (value.trim() === "") throw new FleetError("INVALID_INPUT", `${flag} was given an empty value`);
  if (value.startsWith("--")) throw new FleetError("INVALID_INPUT", `${flag} was given an option, not a value`);
}

/**
 * The server, by type only.
 *
 * A type import is erased at build time, so this module still never causes
 * `src/mcp-server.ts` -- which connects a stdio transport at module scope -- to
 * be loaded. The handler signature the SDK infers is `(args: unknown, extra)`,
 * so each handler narrows its own arguments; `z.strictObject` has already
 * rejected anything that is not this shape at the protocol boundary.
 */
type ToolHost = Pick<McpServer, "registerTool">;

type AsText = (payload: unknown) => { content: Array<{ type: "text"; text: string }> };

/**
 * Run one fleet command and wrap whatever it produced.
 *
 * The ONLY thing this adds over the core: the envelope, and the `next_actions`
 * guidance the CLI writes for the same case. `extra.signal` becomes the run
 * context's cancellation source, so an aborted MCP request kills the same live
 * `git` children a CLI ctrl-C does, and reports `CANCELLED` in the same shape.
 */
async function runFleetTool<T>(
  command: string,
  args: FleetToolArgs,
  signal: AbortSignal,
  collect: (input: { agentId?: string; projectRegistry?: string; agentRegistry?: string; contract?: string; runContext: ReturnType<typeof createRunContext> }) => Promise<T>,
  succeed: (value: T) => FleetEnvelopeV1,
  failureActions: (error: FleetError) => string[],
): Promise<FleetEnvelopeV1> {
  try {
    requireValue(args.agent, "agent");
    requireValue(args.projectRegistry, "projectRegistry");
    requireValue(args.agentRegistry, "agentRegistry");
    requireValue(args.contract, "contract");
    const runContext = createRunContext({ signal, deadlineMs: args.deadlineMs });
    const value = await collect({
      agentId: args.agent,
      projectRegistry: args.projectRegistry,
      agentRegistry: args.agentRegistry,
      contract: args.contract,
      runContext,
    });
    return succeed(value);
  } catch (error) {
    const normalized = normalizeFleetError(error);
    return fleetFailureEnvelope(command, normalized, failureActions(normalized));
  }
}

/**
 * The CLI's own `next_actions`, reproduced exactly.
 *
 * Duplicated deliberately rather than imported: `src/fleet/cli.ts` builds them
 * inside its Commander actions, and exporting those would export the action
 * bodies. The parity assertion in `tests/mcp-server-regressions.mjs` compares
 * `command`, `data` and `error` -- the machine contract -- and these strings are
 * the human guidance beside it.
 */
function inventoryEnvelope(inventory: FleetInventory): FleetEnvelopeV1 {
  return fleetSuccessEnvelope(INVENTORY_COMMAND, inventory, inventory.health.healthy
    ? ["Consume data.rows as the fleet's declared state; every value names the authority that owns it"]
    : [inventory.health.conflicts
      ? "Rule on each unpermitted conflict group: repair the drift, or record it under classifications.intentionally_unmanaged"
      : "Review data.findings; each names the owning registry and the field path to repair"]);
}

function provenanceEnvelope(provenance: FleetProvenance): FleetEnvelopeV1 {
  return fleetSuccessEnvelope(PROVENANCE_COMMAND, provenance, provenance.health.healthy && provenance.health.complete
    ? ["Consume data.facts as the fleet's proven provenance; every fact names the source of both sides"]
    : [provenance.health.mismatched
      ? "Repoint each mismatched agent at the configured pin, or move the pin -- data.facts names both sides and the authority that owns the field"
      : provenance.health.missing
        ? "Record the missing values on the owning side; an absent pin is never a match"
        : "Review data.probes: a fact reported unobserved was not read, and nothing may be claimed about it"]);
}

function budgetAwareActions(what: string): (error: FleetError) => string[] {
  return (error) => [
    error.code === "TIMEOUT" || error.code === "CANCELLED"
      ? `Re-run with a larger deadlineMs; no partial ${what} is reported, because a partial one must never be mistaken for a complete one`
      : `Fix the reported source path, or run \`pjangler fleet contract validate\` if the fault is in the contract`,
  ];
}

/**
 * Expose `fleet inventory` and `fleet provenance` as MCP tools.
 *
 * `isError` is `!envelope.ok`, matching the rest of the catalog, and the payload
 * is the COMPLETE fleet envelope as JSON text -- the same document `--json`
 * writes to stdout, so an automation client and an operator are reading one
 * contract. `structuredContent`/`outputSchema` are deliberately not used;
 * nothing else in this server does, and introducing them on two tools would
 * split the surface.
 */
export function registerFleetMcpTools(server: ToolHost, asText: AsText): void {
  server.registerTool(
    "pjangler_fleet_inventory",
    {
      title: "Inventory the Hermes fleet",
      description:
        "Reads the two canonical registries and reports every registered agent with per-field authoritative-source provenance, "
        + "identity conflicts under stable group ids, and independently counted totals. Strictly read-only. "
        + "Returns the fleet JSON v1 envelope; an unhealthy fleet is still ok:true with data.health.healthy false.",
      inputSchema: z.strictObject({ ...FLEET_TOOL_INPUT }),
    },
    async (args: unknown, extra: { signal: AbortSignal }) => {
      const envelope = await runFleetTool(
        INVENTORY_COMMAND, args as FleetToolArgs, extra.signal,
        async (input) => collectFleetInventory(input),
        inventoryEnvelope,
        budgetAwareActions("inventory"),
      );
      return { isError: !envelope.ok, ...asText(envelope) };
    },
  );

  server.registerTool(
    "pjangler_fleet_provenance",
    {
      title: "Report Hermes fleet provenance",
      description:
        "Pairs every recorded or pinned fleet value with its live counterpart -- template gitlink, host pin, per-agent hermes "
        + "executable, checkout identity, HEAD and cleanliness -- each side naming its own source and categorized "
        + "match/mismatch/dirty/missing/unsupported/unobserved. Never executes the observed binary and never touches the network. "
        + "Returns the fleet JSON v1 envelope; a drifted fleet is still ok:true with data.health.healthy false.",
      inputSchema: z.strictObject({ ...FLEET_TOOL_INPUT }),
    },
    async (args: unknown, extra: { signal: AbortSignal }) => {
      const envelope = await runFleetTool(
        PROVENANCE_COMMAND, args as FleetToolArgs, extra.signal,
        async (input) => collectFleetProvenance(input),
        provenanceEnvelope,
        budgetAwareActions("provenance"),
      );
      return { isError: !envelope.ok, ...asText(envelope) };
    },
  );
}
