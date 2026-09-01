import type { Command } from "commander";
import {
  FLEET_CONTRACT_RELATIVE_PATH,
  loadFleetContract,
  resolveFleetContractPath,
  serializeFleetContract,
  validateFleetContract,
} from "./contract";
import {
  boundedContext,
  boundedValue,
  bounded,
  diagnosticDetails,
  fleetEnvelopeExitCode,
  fleetFailureEnvelope,
  fleetSuccessEnvelope,
  formatFleetContractReport,
  ignoreBrokenPipe,
  normalizeFleetError,
  redactHome,
  renderFleetJson,
  type BoundedContext,
  type FleetContractInspection,
  type FleetEnvelopeV1,
} from "./output";
import { FLEET_SUPPORTED_SCHEMA_VERSIONS, FleetError, type FleetDiagnostic } from "./types";

const VALIDATE_COMMAND = "fleet.contract.validate";

/** Notes carried in an authority view before the envelope's list cap applies. */
const MAX_NOTES = 10;
/** Matches `MAX_ITEMS` in output.ts, so every list in the envelope obeys one bound. */
const MAX_LIST_ITEMS = 100;

interface ValidateOptions {
  contract?: string;
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

function boundedNotes(notes: readonly string[] | undefined, context: BoundedContext, path: string): string[] {
  const all = notes ?? [];
  if (all.length > MAX_NOTES) context.truncated.push(`${path}: ${all.length - MAX_NOTES} of ${all.length} notes dropped`);
  return all.slice(0, MAX_NOTES).map((note) => bounded(note));
}

/**
 * Bound a declared string list and record the clip.
 *
 * `writable_fields`, `store_env` and `detect` were copied with a bare spread,
 * so a contract with thousands of entries produced an envelope past every
 * documented bound while `truncated` stayed empty -- the one list whose whole
 * job is to say "you did not get all of it" was the one that could not say so.
 */
function cappedStrings(values: readonly string[] | undefined, context: BoundedContext, path: string): string[] {
  const all = values ?? [];
  if (all.length > MAX_LIST_ITEMS) context.truncated.push(`${path}: ${all.length - MAX_LIST_ITEMS} of ${all.length} items dropped`);
  return all.slice(0, MAX_LIST_ITEMS).map((value) => bounded(value));
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
export function fleetParserFailureEnvelope(_args: readonly string[]): FleetEnvelopeV1<never> {
  // One command in the namespace today, so there is nothing to disambiguate.
  // The argument stays in the signature because the moment `fleet status` lands
  // the envelope has to name which command failed, exactly as `notebook` does.
  return fleetFailureEnvelope(VALIDATE_COMMAND, new FleetError("INVALID_INPUT", "Invalid fleet command arguments"));
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
  const fleet = program.command("fleet").description("Inspect the 33GOD fleet contract");
  const contract = fleet.command("contract").description("Work with the fleet authority and managed-state contract");

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
        write(envelope, json, inspection);
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
        try { write(envelope, json, inspection); }
        catch { process.stdout.write(`${JSON.stringify({ schema_version: 1, ok: false, command: VALIDATE_COMMAND, data: null, error: { code: "INTERNAL_ERROR", message: "Fleet command could not render its own result", retryable: false, details: {} }, next_actions: [] }, null, 2)}\n`); process.exitCode = 6; }
      }
    });
}

function write(envelope: FleetEnvelopeV1, json: boolean, inspection: FleetContractInspection): void {
  if (json) process.stdout.write(renderFleetJson(envelope));
  else process.stdout.write(`${formatFleetContractReport(inspection)}\n`);
  process.exitCode = fleetEnvelopeExitCode(envelope);
}
