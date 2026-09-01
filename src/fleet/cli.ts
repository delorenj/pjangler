import type { Command } from "commander";
import {
  FLEET_CONTRACT_RELATIVE_PATH,
  loadFleetContract,
  resolveFleetContractPath,
  serializeFleetContract,
  validateFleetContract,
} from "./contract";
import { collectFleetInventory } from "./inventory";
import {
  boundedContext,
  boundedNotes,
  boundedValue,
  bounded,
  cappedStrings,
  diagnosticDetails,
  fleetEnvelopeExitCode,
  fleetFailureEnvelope,
  fleetSuccessEnvelope,
  formatFleetContractReport,
  formatFleetErrorReport,
  formatFleetInventoryReport,
  ignoreBrokenPipe,
  normalizeFleetError,
  redactHome,
  renderFleetJson,
  type FleetContractInspection,
  type FleetEnvelopeV1,
} from "./output";
import { FLEET_SUPPORTED_SCHEMA_VERSIONS, FleetError, fleetExitCode, type FleetDiagnostic, type FleetInventory } from "./types";

const VALIDATE_COMMAND = "fleet.contract.validate";
const INVENTORY_COMMAND = "fleet.inventory";

interface ValidateOptions {
  contract?: string;
  json?: boolean;
}

interface InventoryOptions {
  agent?: string;
  projectRegistry?: string;
  agentRegistry?: string;
  json?: boolean;
}

/** An inspection with nothing learned yet, so a failure still renders a report. */
function emptyInspection(contractPath: string, diagnostics: FleetDiagnostic[]): FleetContractInspection {
  return {
    contract_path: contractPath,
    byte_stable: false,
    schema_version: null,
    contract_version: null,
    compatibility: null,
    supported_schema_versions: { ...FLEET_SUPPORTED_SCHEMA_VERSIONS },
    authorities: [],
    projections: [],
    classifications: [],
    service_model: null,
    activation: null,
    retired: [],
    extensions: [],
    truncated: [],
    diagnostics,
  };
}

/**
 * Read and validate the contract. No writes, anywhere, on any path.
 *
 * Returns an inspection rather than throwing for contract-content problems:
 * the human report and the JSON envelope must describe the same finding set,
 * and an exception would leave the human path with nothing to print.
 */
export function inspectFleetContract(override?: string): FleetContractInspection {
  const path = resolveFleetContractPath(override);
  const shown = redactHome(path);
  const canonical = override === undefined;
  const loaded = loadFleetContract(path);
  const { diagnostics, contract, extensions } = validateFleetContract(loaded.document);
  if (!contract) return { ...emptyInspection(shown, diagnostics), extensions };

  // The TRACKED contract is the canonical artifact, so the serializer must
  // reproduce it exactly or tooling can never edit it without a spurious diff.
  // That is a hard failure. An arbitrary operator file handed in with
  // `--contract` owes nobody canonical formatting, so there it stays a fact.
  const byteStable = serializeFleetContract(loaded.document) === loaded.text;
  const findings = [...diagnostics];
  if (canonical && !byteStable) {
    findings.push({
      code: "INVALID_INPUT",
      path: "contract",
      message: "the tracked contract is not its own canonical serialization; re-save it through the yaml round trip",
    });
  }

  const context = boundedContext();
  return {
    contract_path: shown,
    byte_stable: byteStable,
    schema_version: contract.schema_version,
    contract_version: contract.contract_version,
    compatibility: { ...contract.compatibility },
    supported_schema_versions: { ...FLEET_SUPPORTED_SCHEMA_VERSIONS },
    // Every string below is printed as a row of the human report AND carried in
    // the envelope, so all of them go through `bounded` -- not just the prose
    // ones. Unbounded, an escape sequence in a `--contract` file (a candidate
    // file is operator input) reached the terminal raw, and a 30,000-character
    // field reached the envelope whole.
    authorities: Object.entries(contract.authorities).map(([id, authority]) => ({
      id,
      owner: bounded(authority.owner),
      store: bounded(authority.store),
      store_env: cappedStrings(authority.store_env, context, `authorities.${id}.store_env`),
      read_only: authority.read_only === true,
      writable_fields: cappedStrings(authority.writable_fields, context, `authorities.${id}.writable_fields`),
      notes: boundedNotes(authority.notes, context, `authorities.${id}.notes`),
    })),
    projections: contract.projections.map((projection) => ({
      field: bounded(projection.field),
      source: bounded(projection.source),
      target: bounded(projection.target),
      direction: bounded(projection.direction),
      writable_by: bounded(projection.writable_by),
    })),
    classifications: Object.entries(contract.classifications).map(([id, classification]) => ({
      id,
      required_fields: [...classification.required_fields],
      entry_count: classification.entries.length,
      entries: classification.entries.map((entry, index) => boundedValue(entry, context, `classifications.${id}.entries[${index}]`) as Record<string, unknown>),
    })),
    service_model: boundedValue(contract.service_model, context, "service_model") as Record<string, unknown>,
    activation: boundedValue(contract.activation, context, "activation") as Record<string, unknown>,
    retired: contract.retired.map((mode, index) => ({
      id: bounded(mode.id),
      reason: bounded(mode.reason),
      superseded_by: bounded(mode.superseded_by),
      detect: cappedStrings(mode.detect, context, `retired[${index}].detect`),
    })),
    extensions: extensions.map((extension) => ({
      path: bounded(extension.path),
      value: boundedValue(extension.value, context, extension.path),
    })),
    truncated: context.truncated,
    diagnostics: findings,
  };
}

function validateEnvelope(inspection: FleetContractInspection): FleetEnvelopeV1 {
  const first = inspection.diagnostics[0];
  if (!first) {
    // Not "run the command you just ran". The useful next step after a clean
    // contract is the work the contract unblocks.
    return fleetSuccessEnvelope(VALIDATE_COMMAND, inspection, [
      // The file that was actually inspected, not the tracked one. Under
      // `--contract` both next actions pointed at a file the caller never named.
      `Consume the declared authorities from ${inspection.contract_path} rather than re-deriving field ownership`,
      "Record any new managed exception under a lifecycle class before adopting, retiring, or draining it",
    ]);
  }
  const error = new FleetError(
    first.code,
    `${first.path}: ${first.message}`,
    false,
    diagnosticDetails(inspection.diagnostics, { contract_path: inspection.contract_path }),
  );
  return fleetFailureEnvelope(VALIDATE_COMMAND, error, [
    `Edit ${inspection.contract_path} at the reported field paths, then re-run this command`,
  ]);
}

/**
 * The inventory's success envelope. An unhealthy fleet is still `ok: true`.
 *
 * `validateFleetEnvelope` enforces `ok ? data !== null : data === null`, so
 * reporting conflicts as `ok: false` would null out `data` on exactly the runs
 * where the inventory matters most. Only a COMMAND failure -- an unreadable
 * registry, an unknown `--agent`, a bad flag -- is `ok: false`.
 */
function inventoryEnvelope(inventory: FleetInventory): FleetEnvelopeV1 {
  const nextActions = inventory.health.healthy
    ? ["Consume data.rows as the fleet's declared state; every value names the authority that owns it"]
    : [
      inventory.health.conflicts
        ? "Rule on each unpermitted conflict group: repair the drift, or record it under classifications.intentionally_unmanaged"
        : "Review data.findings; each names the owning registry and the field path to repair",
      "Re-run with --json for the complete row set",
    ];
  return fleetSuccessEnvelope(INVENTORY_COMMAND, inventory, nextActions);
}

/** Whether these argv words are a fleet invocation that promised JSON. */
export function isFleetJsonInvocation(args: readonly string[]): boolean {
  return args[0] === "fleet" && args.includes("--json");
}

/**
 * The envelope a caller gets when Commander rejects the arguments.
 *
 * Without it `fleet contract validate --json --bogus` wrote zero bytes and
 * exited 1 -- outside the command's own exit taxonomy, and unparseable by the
 * automation that asked for `--json` in the first place. `notebook` already
 * solves this; the fleet namespace needs the same guarantee.
 */
export function fleetParserFailureEnvelope(args: readonly string[]): FleetEnvelopeV1<never> {
  // Now that the namespace has two commands the envelope has to name the one
  // that failed. Derived from the positional words only: an option VALUE can be
  // anything (`--agent inventory` is a legal, if unlucky, id), so scanning the
  // whole argv for the word would mislabel a validate failure as an inventory
  // one. Commander has already rejected these arguments, so the words are
  // untrusted -- this only picks a label, never a code path.
  const words = args.filter((arg) => !arg.startsWith("-"));
  const command = words[1] === "inventory" ? INVENTORY_COMMAND : VALIDATE_COMMAND;
  return fleetFailureEnvelope(command, new FleetError("INVALID_INPUT", "Invalid fleet command arguments"));
}

/**
 * Refuse a path or id option that Commander bound to something that is not one.
 *
 * Two failures, both real. An explicitly-empty value (`--agent "$UNSET"`) used
 * to fall through to the unscoped default and report success about a request
 * nobody made. And Commander binds the NEXT argv token as the value, so
 * `--agent --json` makes the flag the id: `options.json` stays false and a
 * caller that asked for JSON gets an ANSI report about an agent named `--json`.
 */
function requireValue(value: string | undefined, flag: string): void {
  if (value === undefined) return;
  if (value.trim() === "") throw new FleetError("INVALID_INPUT", `${flag} was given an empty value`);
  if (value.startsWith("--")) throw new FleetError("INVALID_INPUT", `${flag} was given an option, not a value`);
}

/**
 * `pj fleet contract validate`.
 *
 * Mirrors `registerNotebookCli`: a namespace helper, three levels deep through
 * a held const, writing with `process.stdout.write` and setting
 * `process.exitCode`. It never calls `process.exit()` -- that is what truncates
 * buffered stdout under pipe capture, and it is the exact defect this epic is
 * meant to stop reproducing.
 */
export function registerFleetCli(program: Command): void {
  const fleet = program.command("fleet").description("Inspect the 33GOD fleet contract and the registered fleet");
  const contract = fleet.command("contract").description("Work with the fleet authority and managed-state contract");

  // Hangs off `fleet`, not off `contract`: an inventory is a read of the two
  // canonical registries, not a read of the contract file.
  fleet.command("inventory")
    .description("Inventory every registered agent and report identity conflicts (read-only)")
    .option("--agent <id>", "Report only this agent; totals still describe the whole fleet")
    .option("--project-registry <path>", "Inspect this project registry instead of the configured one")
    .option("--agent-registry <path>", "Inspect this agent registry instead of the configured one")
    .option("--json", "Emit the fleet JSON v1 envelope")
    .action((options: InventoryOptions) => {
      ignoreBrokenPipe();
      const json = Boolean(options.json);
      try {
        requireValue(options.agent, "--agent");
        requireValue(options.projectRegistry, "--project-registry");
        requireValue(options.agentRegistry, "--agent-registry");
        const inventory = collectFleetInventory({
          agentId: options.agent,
          projectRegistry: options.projectRegistry,
          agentRegistry: options.agentRegistry,
        });
        write(inventoryEnvelope(inventory), json, () => formatFleetInventoryReport(inventory));
      } catch (error) {
        const normalized = normalizeFleetError(error);
        // Exit 4 and 5 come out of `collectFleetInventory` rethrowing a contract
        // diagnostic's own code, and no store path is the fix for those.
        const contractFault = fleetExitCode(normalized.code) === 4 || fleetExitCode(normalized.code) === 5;
        const envelope = fleetFailureEnvelope(INVENTORY_COMMAND, normalized, [
          contractFault
            ? "Run `pjangler fleet contract validate` -- the fault is in contracts/fleet-contract.yaml, not in a registry"
            : "Re-run without --json for the full report, or fix the reported store path",
        ]);
        try { write(envelope, json, () => formatFleetErrorReport("Fleet inventory failed", normalized)); }
        catch { emitLastResort(INVENTORY_COMMAND); }
      }
    });

  contract.command("validate")
    .description("Validate the fleet contract and report authorities, classes, service model, and retired modes")
    .option("--contract <path>", "Validate this contract instead of the tracked one")
    .option("--json", "Emit the fleet JSON v1 envelope")
    .action((options: ValidateOptions) => {
      ignoreBrokenPipe();
      const json = Boolean(options.json);
      try {
        // An explicitly-passed empty value used to fall through to the tracked
        // contract, so `--contract "$UNSET"` validated a file the caller never
        // named and reported success about it.
        if (options.contract !== undefined && options.contract.trim() === "") {
          throw new FleetError("INVALID_INPUT", "--contract was given an empty path");
        }
        // Commander binds the next argv token as the value, so
        // `--contract --json` makes the FLAG the path: `options.json` stays
        // false and a caller that asked for JSON got the ANSI human report for
        // a file named `--json`. A path never starts with `--`.
        if (options.contract !== undefined && options.contract.startsWith("--")) {
          throw new FleetError("INVALID_INPUT", "--contract was given an option, not a path");
        }
        const inspection = inspectFleetContract(options.contract);
        const envelope = validateEnvelope(inspection);
        write(envelope, json, () => formatFleetContractReport(inspection));
      } catch (error) {
        const normalized = normalizeFleetError(error);
        let shown = "contract";
        try { shown = redactHome(resolveFleetContractPath(options.contract)); } catch { /* keep the placeholder */ }
        const envelope = fleetFailureEnvelope(VALIDATE_COMMAND, new FleetError(
          normalized.code,
          normalized.message,
          normalized.retryable,
          { ...normalized.details, contract_path: shown },
        ));
        const inspection = emptyInspection(shown, [{ code: normalized.code, path: "contract", message: normalized.message }]);
        // The render itself can throw -- `renderFleetJson` validates the
        // envelope it is handed. Outside this catch that escaped the action
        // handler and reached the top-level rethrow as a raw stack trace with
        // `process.exitCode` never set.
        try { write(envelope, json, () => formatFleetContractReport(inspection)); }
        catch { emitLastResort(VALIDATE_COMMAND); }
      }
    });
}

/**
 * One writer for both commands.
 *
 * Takes a formatter THUNK rather than a payload: the human report of a contract
 * inspection and of a fleet inventory have nothing in common but the fact that
 * one of them has to be produced only on the non-JSON path. Typing this to
 * `FleetContractInspection` and hardwiring `formatFleetContractReport` is what
 * would otherwise have forced a second near-identical copy.
 */
function write(envelope: FleetEnvelopeV1, json: boolean, format: () => string): void {
  if (json) process.stdout.write(renderFleetJson(envelope));
  else process.stdout.write(`${format()}\n`);
  process.exitCode = fleetEnvelopeExitCode(envelope);
}

/** Last resort when even rendering the failure envelope threw. */
function emitLastResort(command: string): void {
  process.stdout.write(`${JSON.stringify({
    schema_version: 1,
    ok: false,
    command,
    data: null,
    error: { code: "INTERNAL_ERROR", message: "Fleet command could not render its own result", retryable: false, details: {} },
    next_actions: [],
  }, null, 2)}\n`);
  process.exitCode = 6;
}
