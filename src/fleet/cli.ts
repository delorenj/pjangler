import type { Command } from "commander";
import {
  FLEET_CONTRACT_RELATIVE_PATH,
  loadFleetContract,
  resolveFleetContractPath,
  serializeFleetContract,
  validateFleetContract,
} from "./contract";
import {
  boundedValue,
  bounded,
  diagnosticDetails,
  fleetEnvelopeExitCode,
  fleetFailureEnvelope,
  fleetSuccessEnvelope,
  formatFleetContractReport,
  normalizeFleetError,
  redactHome,
  renderFleetJson,
  type FleetContractInspection,
  type FleetEnvelopeV1,
} from "./output";
import { FLEET_SUPPORTED_SCHEMA_VERSIONS, FleetError, type FleetDiagnostic } from "./types";

const VALIDATE_COMMAND = "fleet.contract.validate";

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
  const loaded = loadFleetContract(path);
  const { diagnostics, contract, extensions } = validateFleetContract(loaded.document);
  if (!contract) return { ...emptyInspection(shown, diagnostics), extensions };

  return {
    contract_path: shown,
    // The tracked file is the canonical artifact, so the serializer must be
    // able to reproduce it exactly; a drifting round trip means the file can no
    // longer be edited by tooling without a spurious diff.
    byte_stable: serializeFleetContract(loaded.document) === loaded.text,
    schema_version: contract.schema_version,
    contract_version: contract.contract_version,
    compatibility: { ...contract.compatibility },
    supported_schema_versions: { ...FLEET_SUPPORTED_SCHEMA_VERSIONS },
    authorities: Object.entries(contract.authorities).map(([id, authority]) => ({
      id,
      owner: authority.owner,
      store: authority.store,
      store_env: [...authority.store_env],
      read_only: authority.read_only === true,
      writable_fields: [...authority.writable_fields],
      notes: (authority.notes ?? []).slice(0, 10).map((note) => bounded(note)),
    })),
    projections: contract.projections.map((projection) => ({
      field: projection.field,
      source: projection.source,
      target: projection.target,
      direction: projection.direction,
      writable_by: projection.writable_by,
    })),
    classifications: Object.entries(contract.classifications).map(([id, classification]) => ({
      id,
      required_fields: [...classification.required_fields],
      entry_count: classification.entries.length,
      entries: classification.entries.map((entry) => boundedValue(entry) as Record<string, unknown>),
    })),
    service_model: boundedValue(contract.service_model) as Record<string, unknown>,
    activation: boundedValue(contract.activation) as Record<string, unknown>,
    retired: contract.retired.map((mode) => ({
      id: mode.id,
      reason: bounded(mode.reason),
      superseded_by: mode.superseded_by,
      detect: [...mode.detect],
    })),
    extensions: extensions.map((extension) => ({ path: extension.path, value: boundedValue(extension.value) })),
    diagnostics,
  };
}

function validateEnvelope(inspection: FleetContractInspection): FleetEnvelopeV1 {
  const first = inspection.diagnostics[0];
  if (!first) {
    return fleetSuccessEnvelope(VALIDATE_COMMAND, inspection, [
      "pj fleet contract validate --json  # machine-readable authority map",
    ]);
  }
  const error = new FleetError(
    first.code,
    `${first.path}: ${first.message}`,
    false,
    diagnosticDetails(inspection.diagnostics, { contract_path: inspection.contract_path }),
  );
  return fleetFailureEnvelope(VALIDATE_COMMAND, error, [
    `Edit ${FLEET_CONTRACT_RELATIVE_PATH} at the reported field paths, then re-run this command`,
  ]);
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
      const json = Boolean(options.json);
      let envelope: FleetEnvelopeV1;
      let inspection: FleetContractInspection | null = null;
      try {
        inspection = inspectFleetContract(options.contract);
        envelope = validateEnvelope(inspection);
      } catch (error) {
        const normalized = normalizeFleetError(error);
        const shown = redactHome(resolveFleetContractPath(options.contract));
        envelope = fleetFailureEnvelope(VALIDATE_COMMAND, new FleetError(
          normalized.code,
          normalized.message,
          normalized.retryable,
          { ...normalized.details, contract_path: shown },
        ));
        inspection = emptyInspection(shown, [{ code: normalized.code, path: "contract", message: normalized.message }]);
      }
      if (json) process.stdout.write(renderFleetJson(envelope));
      else process.stdout.write(`${formatFleetContractReport(inspection)}\n`);
      process.exitCode = fleetEnvelopeExitCode(envelope);
    });
}
