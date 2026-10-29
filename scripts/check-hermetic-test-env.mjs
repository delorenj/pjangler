#!/usr/bin/env node
// PJAN-193 static guard: no test file hands a child process the operator's
// environment.
//
// The operator's shell carries live credentials (PLANE_*, GITHUB_TOKEN,
// OP_SERVICE_ACCOUNT_TOKEN, OPENROUTER_API_KEY, ...) and config overrides
// (MISE_*, SKILLEX_*, PJ_*, HOME, XDG_*). PJAN-188 blanked a fixed list of
// them, which is a denylist: every NEW variable class on the machine reached
// every child silently. Since PJAN-193 a child env is built from an explicit
// allowlist by `hermeticEnv()` in tests/helpers/hermetic-env.mjs, and this
// check keeps it that way. It parses every file under tests/ (the TypeScript
// parser, so a `spawnSync` inside a fixture's template-literal source is text,
// not a call) and reports:
//
//   spread     `{ ...process.env }`                anywhere
//   copy       Object.entries/assign/fromEntries/keys/values or
//              structuredClone over process.env  anywhere
//   default    `env = process.env`, `x ?? process.env`, `x || process.env`
//                                                  anywhere
//   pass       `env: process.env` in the options of a child-spawning call
//   implicit   a child-spawning call whose options carry no `env` at all, so
//              the child inherits process.env wholesale
//
// Child-spawning calls: spawn, spawnSync, exec, execSync, execFile,
// execFileSync, fork (bare or as a property, e.g. cp.spawn), plus
// `new StdioClientTransport(...)` (the MCP SDK spawns the server) and
// `runOnPty(...)` (tests/helpers/pty-run.mjs).
//
// A site that must inherit carries the marker comment
//   // hermetic-env: inherits -- <why>
// on its own line or the line above, AND its file is listed in EXCEPTIONS
// below with the reason. A marker in an unlisted file is itself a finding, and
// so is a listed file with no marked site left (a stale exception rots into a
// blanket pass). tests/helpers/hermetic-env.mjs is the one file allowed to
// read process.env wholesale: it is where the allowlist lives.
//
// Usage:
//   node scripts/check-hermetic-test-env.mjs            # scan tests/
//   node scripts/check-hermetic-test-env.mjs --list     # print every site it judged

import { readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import ts from "typescript";

/**
 * Files allowed to let a child inherit the operator env, each at marked sites
 * only, keyed by path relative to the repo root, valued by the reason.
 *
 * Empty is the steady state, and it is empty: every child in tests/ is built
 * by hermeticEnv(), including the esbuild/npm build steps (npm resolves the
 * local esbuild with an isolated HOME just as well) and the launchers of the
 * bundled TypeScript suites (which pass the Postgres connection settings by
 * name). The fixture forwarding shims in tests/helpers/pack-fixture.mjs pass
 * `env: process.env` inside a template literal: that is the generated script's
 * own, already hermetic, env, and the parser reads it as text, not a call.
 *
 * An entry needs a subject that is the inheritance itself, for example a test
 * of what a child does with the operator's real env.
 */
export const EXCEPTIONS = new Map([
  // ["tests/some-suite.mjs", "why this file's marked sites must inherit"],
]);

const MARKER = /hermetic-env:\s*inherits\b/;
const SPAWNERS = new Set(["spawn", "spawnSync", "exec", "execSync", "execFile", "execFileSync", "fork"]);
const SPAWNING_CONSTRUCTORS = new Set(["StdioClientTransport"]);
const SPAWNING_HELPERS = new Set(["runOnPty"]);
const COPIERS = new Set(["entries", "assign", "fromEntries", "keys", "values"]);
const ALLOWED_FILES = new Set(["tests/helpers/hermetic-env.mjs"]);

const isProcessEnv = (node) => node && ts.isPropertyAccessExpression(node) && node.name.text === "env"
  && ts.isIdentifier(node.expression) && node.expression.text === "process";

/** Strip parentheses and `as`/non-null wrappers so `(process.env as X)` still reads as process.env. */
function unwrap(node) {
  let current = node;
  while (current && (ts.isParenthesizedExpression(current) || ts.isAsExpression(current) || ts.isNonNullExpression(current)
    || (ts.isSatisfiesExpression?.(current) ?? false))) current = current.expression;
  return current;
}

function calleeName(expression) {
  if (ts.isIdentifier(expression)) return expression.text;
  if (ts.isPropertyAccessExpression(expression)) {
    // `/re/.exec(s)` and `db.exec(sql)` are not child processes: as a
    // property, `exec` only counts on a child_process-looking receiver.
    const name = expression.name.text;
    if (name !== "exec") return name;
    const receiver = expression.expression;
    return ts.isIdentifier(receiver) && /child|^cp$/i.test(receiver.text) ? name : undefined;
  }
  return undefined;
}

/** True when `expr` is or falls back to process.env (`a ?? process.env`, `a || process.env`, ternaries). */
function inheritsProcessEnv(expr) {
  const node = unwrap(expr);
  if (!node) return false;
  if (isProcessEnv(node)) return true;
  if (ts.isBinaryExpression(node) && [ts.SyntaxKind.QuestionQuestionToken, ts.SyntaxKind.BarBarToken].includes(node.operatorToken.kind)) {
    return inheritsProcessEnv(node.left) || inheritsProcessEnv(node.right);
  }
  if (ts.isConditionalExpression(node)) return inheritsProcessEnv(node.whenTrue) || inheritsProcessEnv(node.whenFalse);
  return false;
}

/**
 * Judge one source text. Returns every site as { line, kind, text, marked }.
 * `fileName` only selects the parser dialect (.ts vs .mjs).
 */
export function scanSource(text, fileName = "suite.mjs") {
  const kind = fileName.endsWith(".ts") ? ts.ScriptKind.TS : fileName.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.JS;
  const source = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true, kind);
  const lines = text.split("\n");
  const sites = [];
  const lineOf = (node) => source.getLineAndCharacterOfPosition(node.getStart(source)).line;
  const marked = (node) => {
    const line = lineOf(node);
    return MARKER.test(lines[line] ?? "") || MARKER.test(lines[line - 1] ?? "");
  };
  const report = (node, what) => sites.push({
    line: lineOf(node) + 1,
    kind: what,
    text: (lines[lineOf(node)] ?? "").trim().slice(0, 160),
    marked: marked(node),
  });

  /** The options object literal of a spawn-family call, if it is one. */
  const optionsOf = (args) => {
    for (let index = args.length - 1; index >= 0; index--) {
      const arg = unwrap(args[index]);
      if (arg && ts.isObjectLiteralExpression(arg)) return { literal: arg };
      if (arg && !ts.isArrayLiteralExpression(arg) && !ts.isStringLiteralLike(arg) && index > 0) return { opaque: arg };
    }
    return {};
  };

  const judgeSpawn = (node, args) => {
    const { literal, opaque } = optionsOf(args);
    if (!literal) {
      // `spawnSync(cmd, args, options)` with a variable: the env is decided
      // elsewhere and this check cannot see it, so it must be marked.
      report(node, opaque ? "implicit (options not a literal)" : "implicit");
      return;
    }
    const env = literal.properties.find((property) => property.name && ts.isIdentifier(property.name) && property.name.text === "env");
    if (!env) {
      // A spread into the options (`{ cwd, ...options }`) may carry env; it is
      // still unverifiable here, so it counts as implicit unless marked.
      report(node, literal.properties.some(ts.isSpreadAssignment) ? "implicit (options spread)" : "implicit");
      return;
    }
    if (ts.isPropertyAssignment(env) && inheritsProcessEnv(env.initializer)) report(env, "pass");
  };

  const visit = (node) => {
    if (ts.isSpreadAssignment(node) && isProcessEnv(unwrap(node.expression))) report(node, "spread");
    else if (ts.isSpreadElement(node) && isProcessEnv(unwrap(node.expression))) report(node, "spread");
    else if (ts.isCallExpression(node)) {
      const name = calleeName(node.expression);
      const onObject = ts.isPropertyAccessExpression(node.expression) && ts.isIdentifier(node.expression.expression)
        && node.expression.expression.text === "Object";
      // Object.assign(process.env, x) writes INTO this process's env; only a
      // process.env in a source position copies it out.
      const sources = name === "assign" ? node.arguments.slice(1) : node.arguments;
      if (onObject && COPIERS.has(name) && sources.some((arg) => isProcessEnv(unwrap(arg)))) report(node, "copy");
      else if (name === "structuredClone" && node.arguments.some((arg) => isProcessEnv(unwrap(arg)))) report(node, "copy");
      if (name && SPAWNERS.has(name)) judgeSpawn(node, node.arguments);
      else if (name && SPAWNING_HELPERS.has(name)) judgeSpawn(node, node.arguments);
    } else if (ts.isNewExpression(node)) {
      const name = calleeName(node.expression);
      if (name && SPAWNING_CONSTRUCTORS.has(name)) judgeSpawn(node, node.arguments ?? []);
    } else if (ts.isParameter(node) && node.initializer && inheritsProcessEnv(node.initializer)) report(node, "default");
    else if (ts.isBinaryExpression(node) && [ts.SyntaxKind.QuestionQuestionToken, ts.SyntaxKind.BarBarToken].includes(node.operatorToken.kind)
      && isProcessEnv(unwrap(node.right))) {
      // `options.env ?? process.env` is a fallback to the operator env. Only
      // the outermost such expression is reported (the visit does not recurse
      // into a reported subtree's identical shape twice).
      report(node, "default");
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  // A `pass` site nested inside a spawn call is also seen as a fallback by the
  // binary-expression rule; report each line/kind once.
  const seen = new Set();
  return sites.filter((site) => {
    const key = `${site.line}:${site.kind}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function listTestFiles(dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
      listTestFiles(path, out);
    } else if (/\.(mjs|js|cjs|ts|tsx)$/.test(entry.name)) out.push(path);
  }
  return out;
}

/**
 * Scan every test file under `root`/tests against `exceptions`. Returns
 * { violations: string[], sites: [...] } without printing.
 */
export function checkTree(root, exceptions = EXCEPTIONS) {
  const violations = [];
  const sites = [];
  const usedExceptions = new Set();
  for (const path of listTestFiles(join(root, "tests")).sort()) {
    const rel = relative(root, path).split(sep).join("/");
    if (ALLOWED_FILES.has(rel)) continue;
    for (const site of scanSource(readFileSync(path, "utf8"), path)) {
      sites.push({ file: rel, ...site });
      const where = `${rel}:${site.line}`;
      if (!site.marked) {
        violations.push(`${where}  ${site.kind}: ${site.text}`);
      } else if (!exceptions.has(rel)) {
        violations.push(`${where}  ${site.kind}: marked "hermetic-env: inherits" but ${rel} is not in the EXCEPTIONS list of scripts/check-hermetic-test-env.mjs`);
      } else {
        usedExceptions.add(rel);
      }
    }
  }
  for (const file of exceptions.keys()) {
    if (!usedExceptions.has(file)) violations.push(`${file}  stale exception: no marked inheriting site remains; delete its EXCEPTIONS entry`);
  }
  return { violations, sites };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const root = resolve(import.meta.dirname, "..");
  const { violations, sites } = checkTree(root);
  if (process.argv.includes("--list")) {
    for (const site of sites) console.log(`${site.marked ? "waived " : "FLAGGED"}  ${site.file}:${site.line}  ${site.kind}  ${site.text}`);
  }
  if (violations.length) {
    console.error(`hermetic test env: ${violations.length} finding(s). A child env must be built by hermeticEnv() from tests/helpers/hermetic-env.mjs:\n`);
    for (const violation of violations) console.error(`  ${violation}`);
    console.error("\nA site that genuinely must inherit gets a `// hermetic-env: inherits -- <why>` comment and an EXCEPTIONS entry.");
    process.exit(1);
  }
  console.log(`hermetic test env: ok (${sites.length} marked inheriting site(s) across ${EXCEPTIONS.size} excepted file(s))`);
}
