# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.2.27] - 2026-08-09

### Added

- `feat(PJAN-18)`: enforce fleet-shared Bloodbank gateway contract in registry parity.
- `feat(PJAN-37)`: generalize skill pack provisioning with flattened pack inventory (section 3b) and hardened skill-name validation before fanout containment.
- New regression tests for pack-flatten and cross-engine pack-flatten behavior.

### Changed

- Updated `templates/commonproject` submodule pointer to `41f72c1`, incorporating PJAN-37 pack-flatten fixes in generated projects.

### Fixed

- `fix(PJAN-37)`: correct pack-layout docblock and harden skill fanout validation.
