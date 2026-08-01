# PJAN-44 Release Subtasks

1. Reconcile pjangler, CommonProject, and Hermes template local/remote commit topology.
2. Restore `package-lock.json` parity and prove clean `npm ci`.
3. Make every pinned submodule commit remotely reachable and prove clean recursive clone validation.
4. Run PostgreSQL registry tests against an isolated test database with no production-row mutation.
5. Run the complete source, security, package, template, and version release gates.
6. Push prerequisite template repositories in dependency order.
7. Apply one atomic patch bump, commit, create the annotated tag, and push pjangler main plus tag.
8. Publish the exact verified npm tarball.
9. Install from npm and verify version, audit, and disposable HeyMa-shaped migration behavior.
10. Record evidence, autonomous review, remote refs, npm registry proof, and final Plane state.
