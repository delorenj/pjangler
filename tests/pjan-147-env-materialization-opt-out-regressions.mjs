// PJAN-147: a repo can declare that it hand-keeps .env, and secrets.env-op
// then requires the managed materializer to be ABSENT instead of present.
//
// IntelliForia keeps ~30 keys in a hand-written .env and uses .env.op only to
// feed .env.secrets through its own hook. Because its .env.op has active
// references, the comment-only opt-out did not apply. The PJAN-137 migrate
// --all installed materialize-env.sh, and every cd replaced that .env with the
// one-line .env.op. Its nightly prod pull failed for two nights (INT-283).
//
// `"secrets": { "materialize_env": false }` in .project.json is the opt-out.
// With it: audit fails while an .env-overwriting hook or the script is still
// there, migrate removes both, it leaves the repo's own hooks alone, and the
// .env it runs next to is never touched.
import assert from "node:assert/strict";
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { test } from "node:test";

const root = resolve(import.meta.dirname, "..");
const cli = join(root, "dist", "index.js");
const templateScript = join(root, "templates", "commonproject", "template", ".mise", "scripts", "materialize-env.sh");
const MANAGED = "'{{config_root}}/.mise/scripts/materialize-env.sh'";
const OWN_HOOK = "{{config_root}}/.mise/scripts/inject-op-secrets.sh";
const HAND_KEPT_ENV = "GEMINI_API_KEY=keep-me\nSENDGRID_API_KEY=keep-me-too\n";

function cliJson(args) {
  const result = spawnSync(process.execPath, [cli, ...args], {
    cwd: root, encoding: "utf8", maxBuffer: 20 * 1024 * 1024,
    env: { ...process.env, PJ_AGENT_HOOKS_LAYER: "0" },
  });
  assert.ok(result.stdout.trim(), `${args.join(" ")} produced no JSON\n${result.stderr}`);
  return JSON.parse(result.stdout);
}

function repo({ optOut, installed = true, legacy = false }) {
  const dir = mkdtempSync(join(tmpdir(), "pjan-147-"));
  const hooks = [
    ...(installed ? [`[[hooks.enter]]\nrun = "${MANAGED}"\n`] : []),
    ...(legacy ? ["[[hooks.enter]]\nrun = \"op inject -i .env.op > .env\"\n"] : []),
    `[[hooks.enter]]\nrun = "${OWN_HOOK}"\n`,
  ];
  writeFileSync(join(dir, "mise.toml"), `[env]\n_.file = [".env", ".env.secrets"]\n\n${hooks.join("")}`);
  writeFileSync(join(dir, ".gitignore"), ".env\n.env.*\n!.env.op\n");
  writeFileSync(join(dir, ".env.op"), "GEMINI_API_KEY=op://DeLoSecrets/item/credential\n");
  writeFileSync(join(dir, ".env"), HAND_KEPT_ENV);
  writeFileSync(join(dir, ".project.json"), JSON.stringify({ project_name: "fixture", ...(optOut === undefined ? {} : { secrets: { materialize_env: optOut } }) }));
  if (installed) {
    const target = join(dir, ".mise", "scripts", "materialize-env.sh");
    mkdirSync(dirname(target), { recursive: true });
    cpSync(templateScript, target);
    chmodSync(target, 0o755);
  }
  return { dir, close: () => rmSync(dir, { recursive: true, force: true }) };
}

const finding = (dir) => cliJson(["audit", dir, "--json"]).rules.find((rule) => rule.id === "secrets.env-op");

test("opted out, the installed materializer is a finding, not parity", () => {
  const r = repo({ optOut: false });
  try {
    const f = finding(r.dir);
    assert.equal(f.status, "fail");
    assert.ok(f.details.some((d) => /hooks\.enter has 1 hook\(s\) that overwrite \.env/.test(d)), f.details.join("\n"));
    assert.ok(f.details.some((d) => /materialize-env\.sh is present/.test(d)), f.details.join("\n"));
  } finally { r.close(); }
});

test("opted out, migrate removes the hook and the script, keeps the repo's own hook, and never touches .env", () => {
  const r = repo({ optOut: false, legacy: true });
  try {
    const migrated = cliJson(["migrate", "secrets.env-op", r.dir, "--json"]);
    assert.notEqual(migrated.results?.[0]?.status ?? migrated.status, "blocked", JSON.stringify(migrated));
    const mise = readFileSync(join(r.dir, "mise.toml"), "utf8");
    assert.doesNotMatch(mise, /materialize-env\.sh/);
    assert.doesNotMatch(mise, /op inject -i \.env\.op > \.env/);
    assert.ok(mise.includes(`run = "${OWN_HOOK}"`), mise);
    assert.equal(existsSync(join(r.dir, ".mise", "scripts", "materialize-env.sh")), false);
    assert.equal(readFileSync(join(r.dir, ".env"), "utf8"), HAND_KEPT_ENV);
    const after = finding(r.dir);
    assert.equal(after.status, "pass", after.details.join("\n"));
    assert.match(after.summary, /hand-kept/);
  } finally { r.close(); }
});

test("opted out and already clean, the rule passes and migrate is a noop", () => {
  const r = repo({ optOut: false, installed: false });
  try {
    assert.equal(finding(r.dir).status, "pass");
    const before = readFileSync(join(r.dir, "mise.toml"), "utf8");
    cliJson(["migrate", "secrets.env-op", r.dir, "--json"]);
    assert.equal(readFileSync(join(r.dir, "mise.toml"), "utf8"), before, "migrate must not re-add the hook");
  } finally { r.close(); }
});

test("without the opt-out (absent, or any value but false) the materializer is still required", () => {
  for (const optOut of [undefined, true, "false"]) {
    const r = repo({ optOut, installed: false });
    try {
      const f = finding(r.dir);
      assert.equal(f.status, "fail", `materialize_env=${JSON.stringify(optOut)}`);
      assert.ok(f.details.some((d) => /exactly one managed materialize-env hook/.test(d)), f.details.join("\n"));
    } finally { r.close(); }
  }
});
