// PJAN-135: every command pjangler tells an operator to run must exist.
//
// `pj migrate --all` on infra blocked with "run `skillex migrate --project …`".
// On that shell `skillex` was the retired Python CLI, which has no `migrate`
// ("No such command"), and the Node CLI the generated mise task pins could not
// even install behind mise's npm age gate. The remedy named a command that did
// not exist where the operator stood. This suite closes that class: it collects
// every `pj …` / `pjangler …` / `skillex …` command named in pjangler's own
// strings and in the skillex fix text pjangler relays, and resolves each one
// against the REAL CLI (src/index.ts bundled into a /tmp dir, never the repo's
// dist/) and the REAL bundled @delorenj/skillex, option by option.
import assert from "node:assert/strict";
import { buildSync } from "esbuild";
import { spawn, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { after, test } from "node:test";
import ts from "typescript";

const root = resolve(import.meta.dirname, "..");
const work = mkdtempSync("/tmp/pjan135-guidance-");
after(() => rmSync(work, { recursive: true, force: true }));
// Bare imports (commander, @delorenj/skillex) resolve through this link exactly
// as they do for the installed CLI, and createRequire(import.meta.url) inside
// `pj skills` finds the package pjangler actually depends on.
symlinkSync(join(root, "node_modules"), join(work, "node_modules"));
const common = { bundle: true, packages: "external", platform: "node", format: "esm", logLevel: "warning" };
buildSync({ ...common, entryPoints: [join(root, "src", "index.ts")], outfile: join(work, "pj.mjs") });
buildSync({
  ...common,
  stdin: {
    contents: [
      'export { migrationGuidance, relaySkillexCommands, PJ_SKILLS } from "./src/parity/skills";',
      'export { bundledSkillex, skillsPassthroughArgs } from "./src/skills/cli";',
    ].join("\n"),
    resolveDir: root,
  },
  outfile: join(work, "lib.mjs"),
});
const lib = await import(pathToFileURL(join(work, "lib.mjs")).href);

const home = join(work, "home");
mkdirSync(home);
const env = {
  ...process.env,
  HOME: home,
  XDG_CONFIG_HOME: join(home, ".config"),
  XDG_STATE_HOME: join(work, "state"),
  XDG_CACHE_HOME: join(work, "cache"),
};
function pj(args, options = {}) {
  return spawnSync(process.execPath, [join(work, "pj.mjs"), ...args], { encoding: "utf8", env, cwd: work, ...options });
}

/** `pj <words> --help` against the CLI bundled at `bundle`, parsed: the command path commander (or skillex) resolved. */
function helpFor(bundle) {
  const helpCache = new Map();
  return (words) => {
    const key = words.join(" ");
    if (!helpCache.has(key)) {
      const result = spawnSync(process.execPath, [bundle, ...words, "--help"], { encoding: "utf8", env, cwd: work });
      const usage = /^Usage: (pjangler|skillex)((?: [a-z][\w:.-]*)*)/m.exec(result.stdout);
      const resolved = usage ? usage[2].trim().split(/\s+/).filter(Boolean) : [];
      helpCache.set(key, {
        status: result.status,
        text: result.stdout,
        program: usage?.[1],
        path: usage?.[1] === "skillex" ? ["skills", ...resolved] : resolved,
        stderr: result.stderr,
      });
    }
    return helpCache.get(key);
  };
}
const help = helpFor(join(work, "pj.mjs"));

const ARG = "\u0000ARG\u0000";
const WORD = /^[a-z][\w:.-]*$/;

/**
 * Split a mention into command tokens, stopping where the prose resumes: at a
 * newline, a pipe or `(`, a closing backtick/quote, or trailing punctuation.
 * A token that STARTS with a quote is one (possibly spaced) argument.
 */
function commandTokens(rest) {
  const raw = rest.split("\n")[0].split(/\s+/).filter(Boolean);
  const tokens = [];
  for (let index = 0; index < raw.length; index++) {
    let token = raw[index];
    if (/^["']/.test(token)) {
      const quote = token[0];
      let joined = token;
      while (!new RegExp(`.${quote}[.,;:)]*$`).test(joined) && index + 1 < raw.length) joined += ` ${raw[++index]}`;
      tokens.push(ARG);
      if (/[.,;:)]$/.test(joined)) break;
      continue;
    }
    if (/^[|(;&]/.test(token)) break;
    const cut = token.search(/[`"')]/);
    const stop = cut >= 0 || /[.,;:]$/.test(token);
    if (cut >= 0) token = token.slice(0, cut);
    token = token.replace(/[.,;:]+$/, "");
    if (token) tokens.push(token.includes(ARG) ? ARG : token);
    if (stop) break;
  }
  return tokens;
}

/**
 * Every command mention in `text`. `pj` is always a command. `pjangler` is also
 * the product's name, so it counts as code after a backtick or a double quote.
 * At the very start of a string it is ambiguous ("pjangler doctor" is a
 * next-step command, "pjangler package is missing …" is a sentence), so such a
 * mention is `lenient`: checked in full only when its first word is a command.
 */
function mentions(text) {
  const found = [];
  for (const match of text.matchAll(/(?<![\w/@.:-])(pj|pjangler)\s+(?=[a-z])/g)) {
    const before = text[match.index - 1];
    const code = match[1] === "pj" || before === "`" || before === '"';
    if (!code && match.index !== 0) continue;
    const tokens = commandTokens(text.slice(match.index + match[0].length));
    if (tokens.length && WORD.test(tokens[0])) {
      found.push({ text: `${match[1]} ${tokens.join(" ")}`.replaceAll(ARG, "<arg>"), tokens, lenient: !code });
    }
  }
  return found;
}

/**
 * Resolve one mention against the real CLI; returns a failure message or null.
 *
 * Every word must resolve, not only the first. `pj <group> <missing> --help`
 * makes commander print the GROUP's help with exit 0, so a removed nested
 * subcommand (`pj recipe describe`, `pj notebook capture retry`) used to stay
 * green (PJAN-135 review). A word past the resolved path is fine only as a
 * positional argument of a command that has no subcommands of its own
 * (`pj add docker`, `pj migrate bmad.version`); under a command that lists
 * "Commands:" it can only have been an unknown subcommand.
 */
function unresolved(mention, show = help) {
  const words = [];
  for (const token of mention.tokens) { if (WORD.test(token)) words.push(token); else break; }
  const shown = show(words);
  if (shown.status !== 0) return `\`${mention.text}\`: \`pj ${words.join(" ")} --help\` exited ${shown.status}: ${shown.stderr}`;
  if (!shown.path.length || shown.path[0] !== words[0]) return `\`${mention.text}\`: "${words[0]}" is not a pj command`;
  if (words[0] === "skills" && words.length > 1 && shown.path[1] !== words[1]) {
    return `\`${mention.text}\`: "${words[1]}" is not a command of the bundled skillex`;
  }
  const depth = shown.path.length;
  if (shown.path.some((word, index) => words[index] !== word)) {
    return `\`${mention.text}\`: resolved to \`${shown.path.join(" ")}\`, not \`${words.slice(0, depth).join(" ")}\``;
  }
  if (words.length > depth && /^Commands:$/m.test(shown.text)) {
    return `\`${mention.text}\`: "${words[depth]}" is not a subcommand of \`pj ${shown.path.join(" ")}\``;
  }
  for (const option of mention.tokens.filter((token) => token.startsWith("--"))) {
    const name = option.replace(/=.*$/, "");
    if (!new RegExp(`(^|[\\s,])${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?=[\\s,=<\\[]|$)`, "m").test(shown.text)) {
      return `\`${mention.text}\`: ${name} is not an option of \`${shown.program} ${shown.path.join(" ")}\``;
    }
  }
  return null;
}

/** The real skillex subcommands, from the real bundled CLI's own help. */
function skillexCommands() {
  const text = help(["skills"]).text;
  const section = text.slice(text.indexOf("\nCommands:\n"));
  return [...section.matchAll(/^ {2}([a-z][\w-]*)/gm)].map((match) => match[1]).filter((name) => name !== "help");
}

function stringLiterals() {
  const out = [];
  const walk = function* (dir) {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) yield* walk(path);
      else if (path.endsWith(".ts")) yield path;
    }
  };
  for (const file of walk(join(root, "src"))) {
    const source = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true);
    const visit = (node) => {
      let text;
      if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) text = node.text;
      else if (ts.isTemplateExpression(node)) text = node.head.text + node.templateSpans.map((span) => ARG + span.literal.text).join("");
      if (text !== undefined) {
        const line = source.getLineAndCharacterOfPosition(node.getStart()).line + 1;
        out.push({ where: `${relative(root, file)}:${line}`, text });
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  return out;
}

test("pj skills is the bundled skillex, at the version pjangler depends on, argv untouched", () => {
  const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  const pinned = manifest.dependencies["@delorenj/skillex"];
  const installed = JSON.parse(readFileSync(createRequire(join(root, "package.json")).resolve("@delorenj/skillex/package.json"), "utf8"));
  assert.equal(installed.version, pinned, "node_modules must hold exactly the pinned skillex");
  assert.equal(lib.bundledSkillex().version, pinned);

  const version = pj(["skills", "--version"]);
  assert.equal(version.status, 0, version.stderr);
  assert.equal(version.stdout.trim(), pinned, "`pj skills --version` is skillex's version, not pjangler's");
  for (const args of [["skills"], ["skills", "--help"]]) {
    const shown = pj(args);
    assert.equal(shown.status, 0, shown.stderr);
    assert.match(shown.stdout, /^Usage: skillex \[options\] \[command\]/m, `pj ${args.join(" ")} shows skillex's help`);
  }
  const migrate = pj(["skills", "migrate", "--help"]);
  assert.equal(migrate.status, 0, migrate.stderr);
  assert.match(migrate.stdout, /^Usage: skillex migrate \[options\]/m);
  assert.match(migrate.stdout, /--project <path>/);
  assert.match(migrate.stdout, /--mapping <path>/);

  // Exit codes propagate: a usage error is skillex's exit 2, not pj's 0/1.
  const usage = pj(["skills", "no-such-subcommand"]);
  assert.equal(usage.status, 2, usage.stdout + usage.stderr);
  assert.match(usage.stderr, /E_USAGE/);
  // `--` and everything after it reach skillex exactly as typed.
  assert.deepEqual(lib.skillsPassthroughArgs(["skills", "--", "--version"], ["--version"]), ["--", "--version"]);
  const dashdash = pj(["skills", "--", "--version"]);
  assert.equal(dashdash.status, 2, "skillex received the literal `--`, so --version is an operand");
  // pjangler's own program options still work before the subcommand.
  assert.match(pj(["--help"]).stdout, /^ {2}skills \[args\.\.\.\] +Run the bundled Skillex/m);
});

// PJAN-135 review: `pj skills` blocked in spawnSync and installed no signal
// handlers, so a SIGTERM/SIGINT/SIGHUP/SIGQUIT sent to pj's pid alone (a
// supervisor, execFile's timeout, a Python subprocess timeout — exactly how
// the Hermes PM runs guidance commands) killed pj at once and orphaned skillex,
// which kept running and writing while the caller saw 143 and assumed it had
// stopped. The child here is the REAL bundled skillex, slowed only by a
// preload that waits 3s before its CLI runs and records its pid.
test("pj skills forwards termination signals to skillex, waits for it, and ends the way skillex ended", async () => {
  const bin = lib.bundledSkillex().bin;
  const preload = join(work, "slow-skillex.mjs");
  writeFileSync(preload, [
    'import { writeFileSync } from "node:fs";',
    "if (process.argv[1] === process.env.PJ_TEST_SKILLEX_BIN) {",
    "  writeFileSync(`${process.env.PJ_TEST_MARK}.start`, String(process.pid));",
    "  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 3000);",
    "  writeFileSync(`${process.env.PJ_TEST_MARK}.late`, 'skillex outlived pj');",
    "}",
  ].join("\n"));
  const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
  for (const signal of ["SIGTERM", "SIGINT", "SIGHUP", "SIGQUIT"]) {
    const mark = join(work, `mark-${signal}`);
    // No core files: SIGQUIT's default action dumps core.
    const child = spawn("/bin/sh", ["-c", 'ulimit -c 0; exec "$0" "$@"', process.execPath, join(work, "pj.mjs"), "skills", "--version"], {
      cwd: work,
      stdio: "ignore",
      env: { ...env, NODE_OPTIONS: `--import ${preload}`, PJ_TEST_SKILLEX_BIN: bin, PJ_TEST_MARK: mark },
    });
    const exited = new Promise((done) => child.once("exit", (code, sig) => done({ code, signal: sig })));
    let skillexPid;
    try {
      for (let waited = 0; !existsSync(`${mark}.start`); waited += 20) {
        assert.ok(waited < 15000, `${signal}: skillex never started`);
        await new Promise((done) => setTimeout(done, 20));
      }
      skillexPid = Number(readFileSync(`${mark}.start`, "utf8"));
      assert.ok(alive(skillexPid));
      process.kill(child.pid, signal); // pj's pid only, never the group
      const ended = await exited;
      assert.ok(!alive(skillexPid), `${signal}: skillex (pid ${skillexPid}) still runs after pj exited`);
      assert.equal(existsSync(`${mark}.late`), false, `${signal}: skillex kept writing after pj was stopped`);
      // pj reports the way skillex ended: killed by the same signal.
      assert.deepEqual(ended, { code: null, signal }, `${signal}: ${JSON.stringify(ended)}`);
    } finally {
      if (skillexPid && alive(skillexPid)) process.kill(skillexPid, "SIGKILL");
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    }
  }
  // A normal exit status still propagates unchanged.
  assert.equal(pj(["skills", "no-such-subcommand"]).status, 2);
});

test("migrationGuidance names commands that run, and runs as printed", () => {
  const project = join(work, "a project with spaces");
  mkdirSync(join(project, ".claude", "skills", "legacy"), { recursive: true });
  writeFileSync(join(project, ".claude", "skills", "legacy", "SKILL.md"), "---\nname: legacy\ndescription: legacy\n---\n");
  const catalog = join(work, "catalog");
  mkdirSync(join(catalog, "all-skills", "alpha"), { recursive: true });
  writeFileSync(join(catalog, "all-skills", "alpha", "SKILL.md"), "---\nname: alpha\ndescription: Fixture alpha\n---\n");

  const guidance = lib.migrationGuidance({ repoRoot: project });
  assert.doesNotMatch(guidance, /(?<!pj )\bskillex (?:migrate|sync)/, "no bare skillex command");
  const named = mentions(guidance);
  assert.equal(named.length, 2, `preview and apply: ${JSON.stringify(named)}`);
  for (const mention of named) assert.equal(unresolved(mention), null);
  assert.deepEqual(named.map((mention) => mention.text), [
    "pj skills migrate --project <arg>",
    "pj skills migrate --project <arg> --apply",
  ]);
  // Every option the guidance mentions (including the prose `--mapping`)
  // belongs to the command it names.
  const options = [...new Set(guidance.match(/--[a-z][\w-]*/g))];
  assert.deepEqual(options.sort(), ["--apply", "--mapping", "--project"]);
  for (const option of options) assert.match(help(["skills", "migrate"]).text, new RegExp(`\\s${option}\\b`));
  assert.match(guidance, /never claims ownership of foreign or installer-owned skills/);
  assert.match(guidance, /never deletes content that is not a proven duplicate/);

  // Paste the preview into a shell with only `pj` on PATH: it must run
  // skillex's migrate preview against exactly this project, spaces and all.
  const preview = /Preview: (pj skills migrate --project "[^"]+")\./.exec(guidance)?.[1];
  assert.ok(preview, guidance);
  const bin = join(work, "bin");
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(bin, "pj"), `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(join(work, "pj.mjs"))} "$@"\n`);
  chmodSync(join(bin, "pj"), 0o755);
  const ran = spawnSync("/bin/sh", ["-c", preview], {
    encoding: "utf8",
    cwd: work,
    env: { ...env, PATH: `${bin}:/usr/bin:/bin`, PJ_SKILLS_REGISTRY_ROOT: catalog },
  });
  assert.match(ran.stdout, /^Migration preview: /m, ran.stdout + ran.stderr);
  assert.ok(ran.stdout.includes(join(project, ".claude", "skills", "legacy")), "the preview inspected this project");
  assert.match(ran.stdout, /No changes applied\. Use --apply/);
  assert.notEqual(ran.status, 1, ran.stderr);
  assert.doesNotMatch(ran.stderr, /No such command|unknown command|not found/i);
});

const literalText = (node) => {
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
  if (ts.isTemplateExpression(node)) return node.head.text + node.templateSpans.map((span) => ARG + span.literal.text).join("");
  return undefined;
};

/**
 * The core's fix text, read with the TypeScript parser from the real dist:
 * every string or template literal anywhere in a `fix:` property's value, so
 * both branches of a ternary and every part of a concatenation count. The
 * regex this replaces needed a literal right after `fix:` and so skipped the
 * ternary-built fixes (PJAN-135 review: "Run skillex migrate to convert this
 * manifest…", "Run skillex init for this scope…"). `all` is every literal in
 * the core, for the completeness check below.
 */
function coreLiterals() {
  const path = join(dirname(createRequire(join(root, "package.json")).resolve("@delorenj/skillex/package.json")), "dist", "index.js");
  const source = ts.createSourceFile(path, readFileSync(path, "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const fixes = [];
  const all = [];
  const collect = (node, into) => {
    const text = literalText(node);
    if (text !== undefined) into.push({ text, line: source.getLineAndCharacterOfPosition(node.getStart()).line + 1 });
    ts.forEachChild(node, (child) => collect(child, into));
  };
  const visit = (node) => {
    if (ts.isPropertyAssignment(node) && (ts.isIdentifier(node.name) || ts.isStringLiteral(node.name)) && node.name.text === "fix") collect(node.initializer, fixes);
    ts.forEachChild(node, visit);
  };
  visit(source);
  collect(source, all);
  return { fixes, all };
}

test("the fix scan reads every literal of a fix expression, and misses no skillex command the core names", () => {
  const { fixes, all } = coreLiterals();
  const texts = fixes.map((fix) => fix.text);
  // The two ternary-built fixes the regex scan skipped.
  assert.ok(texts.some((text) => /^Run skillex migrate to convert this manifest/.test(text)), "ternary branch of the manifest fix");
  assert.ok(texts.some((text) => /^Run skillex init for this scope/.test(text)), "ternary branch of the scope fix");
  // Completeness: every literal in the core that names a skillex subcommand is
  // fix text this suite relays and resolves. A new place the core puts such a
  // command (a positional `fix` argument, say) fails here until it is covered.
  const commands = skillexCommands();
  const names = new RegExp(`(?<![\\w/@.:-])skillex\\s+(?:${commands.join("|")})\\b`);
  const uncovered = all.filter((literal) => names.test(literal.text) && !fixes.some((fix) => fix.line === literal.line && fix.text === literal.text));
  assert.deepEqual(uncovered, []);
});

test("the resolver fails a removed nested subcommand instead of accepting its group's help", () => {
  // A /tmp build of the real CLI with ONE nested subcommand renamed.
  const source = readFileSync(join(root, "src", "index.ts"), "utf8");
  const mutated = source.replace(/(recipeCmd\s*\n\s*\.command\()"describe"\)/, '$1"show")');
  assert.notEqual(mutated, source, "the mutation applies");
  const bundle = join(work, "pj-mutated.mjs");
  buildSync({ ...common, stdin: { contents: mutated, resolveDir: join(root, "src"), sourcefile: "index.ts", loader: "ts" }, outfile: bundle });
  const broken = spawnSync(process.execPath, [bundle, "recipe", "describe", "mise"], { encoding: "utf8", env, cwd: work });
  assert.notEqual(broken.status, 0, "the mutated CLI really lost `pj recipe describe`");
  const [mention] = mentions("Run `pj recipe describe <name>` to see its checks");
  assert.equal(unresolved(mention), null, "the real CLI resolves it");
  assert.match(unresolved(mention, helpFor(bundle)) ?? "", /"describe" is not a subcommand of `pj recipe`/);
  // A word-shaped positional argument of a leaf command is still fine.
  assert.equal(unresolved(mentions("run `pj add docker` next")[0]), null);
});

test("every skillex command the core's fix text names is relayed as a pj skills command that resolves", () => {
  const fixes = coreLiterals().fixes.map((fix) => fix.text).filter((text) => /\bskillex\s+[a-z]/.test(text));
  assert.ok(fixes.length >= 20, `the real core names skillex commands in its fix text (${fixes.length})`);
  const commands = skillexCommands();
  assert.ok(commands.includes("migrate") && commands.includes("sync"), commands.join(","));
  const bare = new RegExp(`(?<![\\w/@.:-])skillex\\s+(?:${commands.join("|")})\\b`);
  const failures = [];
  for (const fix of fixes) {
    const relayed = lib.relaySkillexCommands(fix);
    if (bare.test(relayed)) failures.push(`still bare after relay: ${relayed}`);
    const named = mentions(relayed);
    if (!named.length) failures.push(`no pj command after relay: ${relayed}`);
    for (const mention of named) {
      const failure = unresolved(mention);
      if (failure) failures.push(failure);
    }
  }
  assert.deepEqual(failures, []);
});

test("every pj/pjangler command in pjangler's own strings resolves; skillex is named only by the pinned task", () => {
  const commands = skillexCommands();
  const bare = new RegExp(`(?<![\\w/@.:-])skillex\\s+(?:${commands.join("|")})\\b`, "g");
  const failures = [];
  let checked = 0;
  for (const literal of stringLiterals()) {
    for (const mention of mentions(literal.text)) {
      if (mention.lenient && help([mention.tokens[0]]).path[0] !== mention.tokens[0]) continue;
      checked++;
      const failure = unresolved(mention);
      if (failure) failures.push(`${literal.where}: ${failure}`);
    }
    for (const match of literal.text.matchAll(bare)) {
      // The one legitimate bare `skillex`: the run line of the generated
      // skills:sync task, where mise puts the pinned Node CLI on PATH.
      const line = literal.text.slice(literal.text.lastIndexOf("\n", match.index) + 1, match.index);
      if (!/^run = "$/.test(line)) failures.push(`${literal.where}: names bare \`${match[0]}\`; say \`pj skills …\` or \`mise run skills:sync\``);
    }
  }
  assert.ok(checked >= 40, `the scan found the guidance it guards (${checked} mentions)`);
  assert.deepEqual(failures, []);
});
