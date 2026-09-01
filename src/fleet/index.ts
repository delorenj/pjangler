// Public surface of the fleet contract module.
//
// Story 1.1 ships one read-only command. Later Epic 1 stories consume the
// loader, the validator, and the envelope from here rather than re-deriving
// authority answers, which is the whole point of having a contract.

export {
  FLEET_CONTRACT_RELATIVE_PATH,
  collectFleetExtensions,
  loadFleetContract,
  resolveFleetContractPath,
  serializeFleetContract,
  validateFleetContract,
  type FleetContractValidation,
  type LoadedFleetContract,
} from "./contract";

export { inspectFleetContract, registerFleetCli } from "./cli";

export {
  FLEET_COMMANDS,
  bounded,
  boundedValue,
  diagnosticDetails,
  fleetEnvelopeExitCode,
  fleetFailureEnvelope,
  fleetSuccessEnvelope,
  formatFleetContractReport,
  normalizeFleetError,
  redactHome,
  renderFleetJson,
  validateFleetEnvelope,
  type FleetAuthorityView,
  type FleetClassificationView,
  type FleetContractInspection,
  type FleetEnvelopeV1,
  type FleetProjectionView,
  type FleetRetiredView,
} from "./output";

export {
  FLEET_ACTIVATION_STATES,
  FLEET_CLASSIFICATION_IDS,
  FLEET_CLASSIFICATION_REQUIRED_FIELDS,
  FLEET_CONTRACT_SCHEMA_VERSION,
  FLEET_ERROR_CODES,
  FLEET_RETIRED_IDS,
  FLEET_SCHEMA_VERSION,
  FLEET_SUPPORTED_SCHEMA_VERSIONS,
  FleetError,
  fleetExitCode,
  type FleetActivation,
  type FleetAuthority,
  type FleetClassification,
  type FleetContract,
  type FleetDiagnostic,
  type FleetErrorCode,
  type FleetExtension,
  type FleetProjection,
  type FleetRetiredMode,
  type FleetServiceModel,
} from "./types";
