#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const pkg = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8"));
const lock = JSON.parse(
  readFileSync(resolve(root, "package-lock.json"), "utf8"),
);
const lockRoot = lock.packages?.[""];

const stable = (value = {}) => JSON.stringify(value, Object.keys(value).sort());
const failures = [];

if (!lockRoot) failures.push("package-lock.json is missing packages[\"\"]");
if (lock.name !== pkg.name) failures.push("top-level package name differs");
if (lock.version !== pkg.version) failures.push("top-level version differs");
if (lockRoot?.name !== pkg.name) failures.push("root package name differs");
if (lockRoot?.version !== pkg.version) failures.push("root package version differs");
if (stable(lockRoot?.dependencies) !== stable(pkg.dependencies)) {
  failures.push("root dependencies differ");
}
if (stable(lockRoot?.devDependencies) !== stable(pkg.devDependencies)) {
  failures.push("root devDependencies differ");
}
if (stable(lockRoot?.bin) !== stable(pkg.bin)) {
  failures.push("root bin map differs");
}

if (failures.length > 0) {
  console.error(`package-lock parity: FAIL (${failures.join("; ")})`);
  process.exit(1);
}

console.log(`package-lock parity: PASS (${pkg.name}@${pkg.version})`);
