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
// "process.env" below means the env object however it is reached: the literal
// `process.env`, `process["env"]`, `globalThis.process.env`, an import of
// node:process, or a binding initialised from any of those (`const base =
// process.env`, `const { env } = process`, a rest destructure of it), resolved
// file-wide by name to a fixed point. Child-spawning functions are resolved the
// same way through renamed imports (`spawnSync as run`), `const sp = cp.spawn`,
// default/namespace imports of child_process and `promisify(execFile)`. Data
// flow across a call boundary (an env handed to a helper that spawns) is not
// followed; the dynamic guard in tests/pjan-193-env-allowlist-regressions.mjs
// covers that from inside a real child.
//
//   alias      `const base = process.env`, `const { env } = process`: holding
//              the env object in a binding (reading `process.env.HOME` or
//              `const { HOME } = process.env` is fine)
//   spread     `{ ...process.env }`                anywhere
//   copy       Object.entries/assign/fromEntries/keys/values or
//              structuredClone over process.env  anywhere
//   default    `env = process.env`, `x ?? process.env`, `x || process.env`
//                                                  anywhere
//   pass       `env: process.env` in the options of a child-spawning call
//   implicit   a child-spawning call whose options carry no `env` at all, or
//              whose env may be undefined (`env: undefined`, a parameter with
//              no default, `options.env`), or that is followed by a spread that
//              can override it (`{ env, ...options }`): node falls back to
//              process.env wholesale. A spread BEFORE env is fine.
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
//
// PJAN-196 adds a second check, for the SUITE PROCESS itself rather than its
// children. Every registered suite (scripts/run-tests.mjs SUITES plus every
// `node tests/<x>.mjs` in a package.json script) must make
// tests/helpers/hermetic-suite.mjs its FIRST module request, so the preamble
// rebuilds process.env and HOME before any pjangler code loads in-process. A
// suite that must see the operator env in-process is listed in
// PREAMBLE_EXCEPTIONS with its reason (empty). The check also fails when
// run-tests.mjs stops registering this gate or the canaries that prove the
// guards dynamically (REQUIRED_REGISTRATIONS); the PJAN-196 canary suite
// checks the same registrations from the other side.

import { readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import ts from "typescript";

/**
 * Files allowed to let a child inherit the operator env, each at marked sites
 * only, keyed by path relative to the repo root, valued by the reason.
 *
 * Empty is the steady state for children: every child in tests/ is built
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
  // Not a child: the PJAN-196 probe lists the variable NAMES its in-process
  // code sees, so the canary can compare them with what it planted.
  ["tests/pjan-196-suite-env-probe.mjs", "reports the env's variable names (never values) for the PJAN-196 canary; builds no child env"],
]);

const MARKER = /hermetic-env:\s*inherits\b/;
const SPAWNERS = new Set(["spawn", "spawnSync", "exec", "execSync", "execFile", "execFileSync", "fork"]);
const SPAWNING_CONSTRUCTORS = new Set(["StdioClientTransport"]);
const SPAWNING_HELPERS = new Set(["runOnPty"]);
// Object.<name>(process.env) and friends: every way to copy the env out.
const COPIERS = new Set(["entries", "assign", "fromEntries", "keys", "values", "create", "getOwnPropertyDescriptors"]);
const PROCESS_MODULES = new Set(["process", "node:process"]);
// Modules whose default/namespace import spawns children. cross-spawn and execa
// export the spawner itself as the default.
const CP_MODULES = new Set(["child_process", "node:child_process"]);
const SPAWNER_PACKAGES = new Set(["cross-spawn", "execa"]);
const GLOBAL_OBJECTS = new Set(["globalThis", "global"]);
// hermetic-env.mjs holds the allowlist; hermetic-suite.mjs rebuilds the suite
// process's own env from it (PJAN-196). Both read process.env wholesale by design.
const ALLOWED_FILES = new Set(["tests/helpers/hermetic-env.mjs", "tests/helpers/hermetic-suite.mjs"]);

/** The suite-process preamble every registered suite imports first (PJAN-196). */
export const PREAMBLE = "./helpers/hermetic-suite.mjs";

/**
 * Registered suites allowed to run WITHOUT the preamble, i.e. with the
 * operator's whole env in-process, each with the reason. Empty is the steady
 * state, and it is empty. An entry needs a subject that is the operator env
 * itself; a suite that merely needs one more variable gets a SUITE_PASSTHROUGH
 * grant in tests/helpers/hermetic-env.mjs instead.
 */
export const PREAMBLE_EXCEPTIONS = new Map([
  // ["tests/some-suite.mjs", "why this suite must see the operator env in-process"],
]);

/**
 * What scripts/run-tests.mjs must keep registered for these guards to mean
 * anything: a gate that is not in GATES never runs, and a canary that is not
 * in SUITES proves nothing. tests/pjan-196-suite-env-canary.mjs checks the
 * same list, so dropping the gate is caught by a suite and dropping the suites
 * is caught by the gate.
 */
export const REQUIRED_REGISTRATIONS = Object.freeze({
  gates: Object.freeze([["check:hermetic-test-env", "scripts/check-hermetic-test-env.mjs"]]),
  suites: Object.freeze([
    "tests/pjan-188-hermetic-canary-regressions.mjs",
    "tests/pjan-193-env-allowlist-regressions.mjs",
    "tests/pjan-196-suite-env-probe.mjs",
    "tests/pjan-196-suite-env-canary.mjs",
  ]),
});

/** Every string-literal element of `const <name> = [...]` in `text` (nested arrays flattened per entry). */
function arrayLiteral(source, name) {
  let found;
  const visit = (node) => {
    if (found) return;
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === name && node.initializer) {
      let init = unwrap(node.initializer);
      if (init && ts.isNewExpression(init)) init = init.arguments?.[0];
      if (init && ts.isArrayLiteralExpression(init)) {
        found = init.elements.map((element) => (ts.isArrayLiteralExpression(element)
          ? element.elements.filter(ts.isStringLiteralLike).map((item) => item.text)
          : ts.isStringLiteralLike(element) ? element.text : undefined)).filter(Boolean);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found ?? [];
}

/**
 * The registry of scripts/run-tests.mjs, read from its source (importing it
 * would run the suites): { gates: [[name, script]], suites: [path] }.
 */
export function readRunnerRegistry(root) {
  const text = readFileSync(join(root, "scripts", "run-tests.mjs"), "utf8");
  const source = ts.createSourceFile("run-tests.mjs", text, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  return { gates: arrayLiteral(source, "GATES"), suites: arrayLiteral(source, "SUITES") };
}

/**
 * Every file that runs as a SUITE PROCESS: the runner's SUITES plus every
 * `node tests/<x>.mjs` in a package.json script (the network-backed installer
 * contracts run only from there, in publish.yml).
 */
export function registeredSuites(root) {
  const suites = new Set(readRunnerRegistry(root).suites);
  const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  for (const command of Object.values(pkg.scripts ?? {})) {
    for (const match of String(command).matchAll(/\bnode\s+(tests\/[\w./-]+\.mjs)\b/g)) suites.add(match[1]);
  }
  return [...suites].sort();
}

/**
 * The first module request of a suite (an import, or an `export ... from`):
 * ESM evaluates them in this order, so the preamble must be first for it to
 * run before any pjangler code loads. Returns the specifier or undefined.
 */
export function firstModuleRequest(text, fileName = "suite.mjs") {
  const source = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  for (const statement of source.statements) {
    if (ts.isImportDeclaration(statement) && ts.isStringLiteralLike(statement.moduleSpecifier)) {
      // `import type` is erased and requests nothing.
      if (statement.importClause?.isTypeOnly) continue;
      return statement.moduleSpecifier.text;
    }
    if (ts.isExportDeclaration(statement) && statement.moduleSpecifier && ts.isStringLiteralLike(statement.moduleSpecifier)) {
      return statement.moduleSpecifier.text;
    }
  }
  return undefined;
}

/**
 * PJAN-196: every registered suite applies the preamble (its FIRST module
 * request is ./helpers/hermetic-suite.mjs) unless PREAMBLE_EXCEPTIONS lists it,
 * and the guards above stay registered in scripts/run-tests.mjs.
 */
export function checkSuitePreambles(root, exceptions = PREAMBLE_EXCEPTIONS) {
  const violations = [];
  const registry = readRunnerRegistry(root);
  for (const [name, script] of REQUIRED_REGISTRATIONS.gates) {
    if (!registry.gates.some(([gate, path]) => gate === name && path === script)) {
      violations.push(`scripts/run-tests.mjs  gate ${name} (${script}) is not registered in GATES: the guard would never run`);
    }
  }
  for (const suite of REQUIRED_REGISTRATIONS.suites) {
    if (!registry.suites.includes(suite)) violations.push(`scripts/run-tests.mjs  ${suite} is not registered in SUITES: the guard it carries would never run`);
  }
  const suites = registeredSuites(root);
  for (const suite of suites) {
    let text;
    try { text = readFileSync(join(root, suite), "utf8"); } catch {
      violations.push(`${suite}  registered but missing`);
      continue;
    }
    const first = firstModuleRequest(text, suite);
    if (exceptions.has(suite)) {
      if (first === PREAMBLE) violations.push(`${suite}  stale preamble exception: it imports the preamble; delete its PREAMBLE_EXCEPTIONS entry`);
    } else if (first !== PREAMBLE) {
      violations.push(`${suite}  first import is ${first ? JSON.stringify(first) : "missing"}, not "${PREAMBLE}": in-process code would see the operator env and real HOME`);
    }
  }
  for (const suite of exceptions.keys()) {
    if (!suites.includes(suite)) violations.push(`${suite}  stale preamble exception: not a registered suite`);
  }
  return { violations, suites };
}

/** Strip parentheses and `as`/non-null/await wrappers so `(process.env as X)` still reads as process.env. */
function unwrap(node) {
  let current = node;
  while (current && (ts.isParenthesizedExpression(current) || ts.isAsExpression(current) || ts.isNonNullExpression(current)
    || ts.isAwaitExpression(current) || (ts.isSatisfiesExpression?.(current) ?? false))) current = current.expression;
  return current;
}

/** `a.b` -> "b", `a["b"]` -> "b"; anything else undefined. */
function memberName(node) {
  if (ts.isPropertyAccessExpression(node)) return node.name.text;
  if (ts.isElementAccessExpression(node) && node.argumentExpression && ts.isStringLiteralLike(node.argumentExpression)) {
    return node.argumentExpression.text;
  }
  return undefined;
}

const isUndefinedLiteral = (node) => (ts.isIdentifier(node) && node.text === "undefined")
  || node.kind === ts.SyntaxKind.NullKeyword
  || ts.isVoidExpression(node);

/**
 * Judge one source text. Returns every site as { line, kind, text, marked }.
 * `fileName` only selects the parser dialect (.ts vs .mjs).
 *
 * The judgment follows names, not just the literal `process.env` text: a
 * binding initialised from the env (`const base = process.env`,
 * `const { env } = process`, `import { env } from "node:process"`, a rest
 * destructure of it), `globalThis.process`, `process["env"]`, an import of
 * node:process, and a renamed or promisified child_process function
 * (`import { spawnSync as run }`, `const sp = cp.spawnSync`,
 * `promisify(execFile)`) are all resolved, to a fixed point, file-wide and
 * by name. That errs towards flagging: two unrelated bindings sharing a name
 * can produce a false positive, which a rename clears. What it does NOT follow
 * is data flow across a call boundary (an env handed to a helper that spawns):
 * tests/pjan-193-env-allowlist-regressions.mjs covers that from inside a real
 * child, which does not care how the env got there.
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

  // ---- name resolution ------------------------------------------------------
  const processNames = new Set(["process"]); // identifiers that mean the `process` object
  const envNames = new Set(); // identifiers that mean process.env (or a rest-copy of it)
  const cpNames = new Set(); // identifiers that mean the child_process module
  const spawnerNames = new Map(); // local name -> the child_process function it is

  const requiredModule = (node) => {
    const call = unwrap(node);
    if (!call || !ts.isCallExpression(call) || call.arguments.length === 0) return undefined;
    const callee = call.expression;
    const isLoader = (ts.isIdentifier(callee) && callee.text === "require") || callee.kind === ts.SyntaxKind.ImportKeyword;
    const arg = call.arguments[0];
    return isLoader && ts.isStringLiteralLike(arg) ? arg.text : undefined;
  };

  const isProcessRef = (node) => {
    const n = unwrap(node);
    if (!n) return false;
    if (ts.isIdentifier(n)) return processNames.has(n.text);
    if (PROCESS_MODULES.has(requiredModule(n))) return true;
    // globalThis.process / global.process / globalThis["process"]
    return memberName(n) === "process" && ts.isIdentifier(unwrap(n.expression)) && GLOBAL_OBJECTS.has(unwrap(n.expression).text);
  };
  const isEnvRef = (node) => {
    const n = unwrap(node);
    if (!n) return false;
    if (ts.isIdentifier(n)) return envNames.has(n.text);
    return (ts.isPropertyAccessExpression(n) || ts.isElementAccessExpression(n)) && memberName(n) === "env" && isProcessRef(n.expression);
  };
  const isCpRef = (node) => {
    const n = unwrap(node);
    if (!n) return false;
    if (ts.isIdentifier(n)) return cpNames.has(n.text);
    return CP_MODULES.has(requiredModule(n));
  };

  /** Which child_process function `callee` is, resolving renames and promisify. */
  const spawnerOf = (callee) => {
    const n = unwrap(callee);
    if (!n) return undefined;
    if (ts.isIdentifier(n)) {
      if (spawnerNames.has(n.text)) return spawnerNames.get(n.text);
      return SPAWNERS.has(n.text) || SPAWNING_HELPERS.has(n.text) ? n.text : undefined;
    }
    if (ts.isPropertyAccessExpression(n) || ts.isElementAccessExpression(n)) {
      const name = memberName(n);
      if (!name || !(SPAWNERS.has(name) || SPAWNING_HELPERS.has(name))) return undefined;
      // `/re/.exec(s)` and `db.exec(sql)` are not child processes: as a
      // property, `exec` only counts on a receiver known (or named like) child_process.
      if (name !== "exec") return name;
      const receiver = unwrap(n.expression);
      return isCpRef(receiver) || (receiver && ts.isIdentifier(receiver) && /child|^cp$/i.test(receiver.text)) ? name : undefined;
    }
    // promisify(execFile)(...) and util.promisify(cp.execFile)(...)
    if (ts.isCallExpression(n) && memberOrIdent(n.expression) === "promisify" && n.arguments.length > 0) return spawnerOf(n.arguments[0]);
    return undefined;
  };
  const memberOrIdent = (node) => {
    const n = unwrap(node);
    if (!n) return undefined;
    return ts.isIdentifier(n) ? n.text : memberName(n);
  };

  // ---- alias collection, to a fixed point ---------------------------------
  let changed = true;
  const note = (set, name) => { if (!set.has(name)) { set.add(name); changed = true; } };
  const noteSpawner = (name, spawner) => { if (spawnerNames.get(name) !== spawner) { spawnerNames.set(name, spawner); changed = true; } };

  const bindName = (name, init) => {
    if (isProcessRef(init)) note(processNames, name);
    if (isEnvRef(init)) note(envNames, name);
    if (isCpRef(init)) note(cpNames, name);
    const spawner = spawnerOf(init);
    if (spawner) noteSpawner(name, spawner);
  };
  const bindPattern = (pattern, init) => {
    for (const element of pattern.elements) {
      if (!ts.isBindingElement(element) || !ts.isIdentifier(element.name)) continue;
      const imported = element.propertyName && (ts.isIdentifier(element.propertyName) || ts.isStringLiteralLike(element.propertyName))
        ? element.propertyName.text : element.name.text;
      if (element.dotDotDotToken) {
        // `const { HOME, ...rest } = process.env`: a copy of the env.
        if (isEnvRef(init)) note(envNames, element.name.text);
      } else if (isProcessRef(init) && imported === "env") note(envNames, element.name.text);
      else if (isCpRef(init) && SPAWNERS.has(imported)) noteSpawner(element.name.text, imported);
    }
  };
  const collect = (node) => {
    if (ts.isVariableDeclaration(node) && node.initializer) {
      if (ts.isIdentifier(node.name)) bindName(node.name.text, node.initializer);
      else if (ts.isObjectBindingPattern(node.name)) bindPattern(node.name, node.initializer);
    } else if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken && ts.isIdentifier(node.left)) {
      bindName(node.left.text, node.right);
    } else if (ts.isImportDeclaration(node) && ts.isStringLiteralLike(node.moduleSpecifier) && node.importClause) {
      const module = node.moduleSpecifier.text;
      const clause = node.importClause;
      const named = clause.namedBindings;
      if (PROCESS_MODULES.has(module)) {
        if (clause.name) note(processNames, clause.name.text);
        if (named && ts.isNamespaceImport(named)) note(processNames, named.name.text);
        if (named && ts.isNamedImports(named)) {
          for (const spec of named.elements) if ((spec.propertyName ?? spec.name).text === "env") note(envNames, spec.name.text);
        }
      } else if (CP_MODULES.has(module)) {
        if (clause.name) note(cpNames, clause.name.text);
        if (named && ts.isNamespaceImport(named)) note(cpNames, named.name.text);
        if (named && ts.isNamedImports(named)) {
          for (const spec of named.elements) {
            const imported = (spec.propertyName ?? spec.name).text;
            if (SPAWNERS.has(imported)) noteSpawner(spec.name.text, imported);
          }
        }
      } else if (SPAWNER_PACKAGES.has(module)) {
        if (clause.name) noteSpawner(clause.name.text, "spawn");
        if (named && ts.isNamedImports(named)) for (const spec of named.elements) noteSpawner(spec.name.text, "spawn");
      }
    }
    ts.forEachChild(node, collect);
  };
  for (let pass = 0; changed && pass < 8; pass++) {
    changed = false;
    collect(source);
  }

  // ---- judgment -------------------------------------------------------------
  /** True when `expr` is or falls back to process.env (`a ?? process.env`, `a || process.env`, ternaries). */
  const inheritsProcessEnv = (expr) => {
    const node = unwrap(expr);
    if (!node) return false;
    if (isEnvRef(node)) return true;
    if (ts.isBinaryExpression(node) && [ts.SyntaxKind.QuestionQuestionToken, ts.SyntaxKind.BarBarToken].includes(node.operatorToken.kind)) {
      return inheritsProcessEnv(node.left) || inheritsProcessEnv(node.right);
    }
    if (ts.isConditionalExpression(node)) return inheritsProcessEnv(node.whenTrue) || inheritsProcessEnv(node.whenFalse);
    return false;
  };

  /** The parameters (and destructured parameter names) of every function around `node` that bind `name` with no default. */
  const isBareParameter = (node, name) => {
    for (let current = node.parent; current; current = current.parent) {
      if (!ts.isFunctionLike(current)) continue;
      for (const parameter of current.parameters) {
        if (ts.isIdentifier(parameter.name) && parameter.name.text === name && !parameter.initializer) return true;
        if (!ts.isIdentifier(parameter.name)) {
          const stack = [parameter.name];
          while (stack.length) {
            const pattern = stack.pop();
            for (const element of pattern.elements ?? []) {
              if (!ts.isBindingElement(element)) continue;
              if (ts.isIdentifier(element.name)) { if (element.name.text === name && !element.initializer) return true; } else stack.push(element.name);
            }
          }
        }
      }
    }
    return false;
  };

  /**
   * True when the env value of a spawn call may be undefined at run time, which
   * makes node fall back to process.env: a literal undefined/null, a branch of a
   * ternary/`??` that is, a parameter with no default (`function run(args, env)
   * { spawnSync(..., { env }) }` called as `run(args)`), or an `x.env` read off
   * some options object.
   */
  const mayBeUndefined = (expr, anchor) => {
    const node = unwrap(expr);
    if (!node) return false;
    if (isUndefinedLiteral(node)) return true;
    if (ts.isConditionalExpression(node)) return mayBeUndefined(node.whenTrue, anchor) || mayBeUndefined(node.whenFalse, anchor);
    if (ts.isBinaryExpression(node)) {
      const kindOf = node.operatorToken.kind;
      if ([ts.SyntaxKind.QuestionQuestionToken, ts.SyntaxKind.BarBarToken].includes(kindOf)) return mayBeUndefined(node.right, anchor);
      if (kindOf === ts.SyntaxKind.AmpersandAmpersandToken) return true;
      return false;
    }
    if (ts.isIdentifier(node)) return isBareParameter(anchor, node.text);
    if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) return memberName(node) === "env";
    return false;
  };

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
    const isEnvProperty = (property) => property.name && (ts.isIdentifier(property.name) || ts.isStringLiteralLike(property.name)) && property.name.text === "env";
    const envIndex = literal.properties.findIndex(isEnvProperty);
    if (envIndex < 0) {
      // A spread into the options (`{ cwd, ...options }`) may carry env; it is
      // still unverifiable here, so it counts as implicit unless marked.
      report(node, literal.properties.some(ts.isSpreadAssignment) ? "implicit (options spread)" : "implicit");
      return;
    }
    const env = literal.properties[envIndex];
    // `{ env, ...options }`: a later spread overrides the env that was just built.
    if (literal.properties.slice(envIndex + 1).some(ts.isSpreadAssignment)) report(env, "implicit (options spread after env)");
    const value = ts.isShorthandPropertyAssignment(env) ? env.name : ts.isPropertyAssignment(env) ? env.initializer : undefined;
    if (!value) return;
    if (inheritsProcessEnv(value)) report(env, "pass");
    else if (mayBeUndefined(value, env)) report(env, "implicit (env may be undefined)");
  };

  /** A declaration that binds the env object itself (not a value read from it). */
  const isAliasDeclaration = (declaration) => {
    const init = declaration.initializer;
    if (ts.isIdentifier(declaration.name)) return isEnvRef(init);
    if (!ts.isObjectBindingPattern(declaration.name)) return false;
    if (isEnvRef(init)) return declaration.name.elements.some((element) => element.dotDotDotToken); // `{ HOME, ...rest } = process.env`
    return isProcessRef(init) && declaration.name.elements.some((element) => {
      const imported = element.propertyName ?? element.name;
      return (ts.isIdentifier(imported) || ts.isStringLiteralLike(imported)) && imported.text === "env"; // `{ env } = process`
    });
  };

  const visit = (node) => {
    if ((ts.isSpreadAssignment(node) || ts.isSpreadElement(node)) && isEnvRef(node.expression)) report(node, "spread");
    else if (ts.isCallExpression(node)) {
      const callee = unwrap(node.expression);
      const calleeMember = callee && (ts.isPropertyAccessExpression(callee) || ts.isElementAccessExpression(callee)) ? memberName(callee) : undefined;
      const receiver = callee && calleeMember ? unwrap(callee.expression) : undefined;
      const onObject = receiver && ts.isIdentifier(receiver) && receiver.text === "Object";
      const onJson = receiver && ts.isIdentifier(receiver) && receiver.text === "JSON";
      // Object.assign(process.env, x) writes INTO this process's env; only a
      // process.env in a source position copies it out.
      const sources = calleeMember === "assign" ? node.arguments.slice(1) : node.arguments;
      if (onObject && COPIERS.has(calleeMember) && sources.some(isEnvRef)) report(node, "copy");
      else if (onJson && calleeMember === "stringify" && node.arguments.some(isEnvRef)) report(node, "copy");
      else if (callee && ts.isIdentifier(callee) && callee.text === "structuredClone" && node.arguments.some(isEnvRef)) report(node, "copy");
      if (spawnerOf(node.expression)) judgeSpawn(node, node.arguments);
    } else if (ts.isNewExpression(node)) {
      const callee = unwrap(node.expression);
      const name = callee && (ts.isIdentifier(callee) ? callee.text : memberName(callee));
      if (name && SPAWNING_CONSTRUCTORS.has(name)) judgeSpawn(node, node.arguments ?? []);
    } else if (ts.isParameter(node) && node.initializer && inheritsProcessEnv(node.initializer)) report(node, "default");
    else if (ts.isBinaryExpression(node) && [ts.SyntaxKind.QuestionQuestionToken, ts.SyntaxKind.BarBarToken].includes(node.operatorToken.kind)
      && isEnvRef(node.right)) {
      // `options.env ?? process.env` is a fallback to the operator env.
      report(node, "default");
    } else if (ts.isVariableDeclaration(node) && node.initializer && isAliasDeclaration(node)) {
      // `const base = process.env` / `const { env } = process` / a rest copy:
      // holding the operator env in a binding is how it reaches a child later.
      report(node, "alias");
    } else if (ts.isImportSpecifier(node) && ts.isImportDeclaration(node.parent.parent.parent)
      && PROCESS_MODULES.has(node.parent.parent.parent.moduleSpecifier.text) && (node.propertyName ?? node.name).text === "env") {
      report(node, "alias");
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
  const preambles = checkSuitePreambles(root);
  if (process.argv.includes("--list")) {
    for (const site of sites) console.log(`${site.marked ? "waived " : "FLAGGED"}  ${site.file}:${site.line}  ${site.kind}  ${site.text}`);
  }
  if (violations.length) {
    console.error(`hermetic test env: ${violations.length} finding(s). A child env must be built by hermeticEnv() from tests/helpers/hermetic-env.mjs:\n`);
    for (const violation of violations) console.error(`  ${violation}`);
    console.error("\nA site that genuinely must inherit gets a `// hermetic-env: inherits -- <why>` comment and an EXCEPTIONS entry.");
  }
  if (preambles.violations.length) {
    console.error(`hermetic suite env: ${preambles.violations.length} finding(s). Every registered suite's first import is "${PREAMBLE}" (PJAN-196):\n`);
    for (const violation of preambles.violations) console.error(`  ${violation}`);
    console.error("\nA suite that must see the operator env in-process gets a PREAMBLE_EXCEPTIONS entry with the reason.");
  }
  if (violations.length || preambles.violations.length) process.exit(1);
  console.log(`hermetic test env: ok (${sites.length} marked inheriting site(s) across ${EXCEPTIONS.size} excepted file(s); `
    + `${preambles.suites.length} registered suite(s) start from the preamble, ${PREAMBLE_EXCEPTIONS.size} excepted)`);
}
