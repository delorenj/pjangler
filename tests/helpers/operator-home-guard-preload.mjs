// PJAN-198 preload: `node --import tests/helpers/operator-home-guard-preload.mjs
// <bundle>` installs the operator-home guard (./operator-home-guard.mjs) in a
// bundled TypeScript suite's child, judged as the launcher suite named in
// PJ_OPERATOR_HOME_GUARD_SUITE. The name is removed from the env first, so the
// child's own code, and its children, never see it. Launchers get the args and
// the env from BUNDLED_CHILD_GUARD in ./hermetic-suite.mjs.
import { GUARD_SUITE_ENV, installOperatorHomeGuard } from "./operator-home-guard.mjs";

const suite = process.env[GUARD_SUITE_ENV];
if (suite === undefined) throw new Error(`operator-home-guard-preload: ${GUARD_SUITE_ENV} is not set; launch through BUNDLED_CHILD_GUARD`);
delete process.env[GUARD_SUITE_ENV];
installOperatorHomeGuard(suite);
