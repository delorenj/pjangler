import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export const PACK_FIXTURE_NAME = "pjtest";
export const PACK_FIXTURE_VERSION = "6.10.1-next.31";
export const BMAD_INSTALLER_FIXTURE_VERSION = "6.11.1-next.1";

// A deliberately small authenticated pack. It exercises inventory, integrity,
// projections, and multi-link rollback.
//
// PJAN-76: this fixture used to be named `bmad`, back when pjangler pinned a
// Skillex `bmad` pack implicitly. BMAD is the installer's now, and a pack that
// claims the `bmad-*` namespace would fight it for the same paths — so these
// tests exercise the pack machinery under a name of its own, which is what
// they were always really testing.
export const PACK_FIXTURE_SKILLS = [
  "pjtest-agent-analyst",
  "pjtest-agent-pm",
  "pjtest-architecture",
  "pjtest-code-review",
  "pjtest-dev-story",
  "pjtest-help",
  "pjtest-product-brief",
  "pjtest-testarch-trace",
];

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

export function createSkillPackFixture(parentDir) {
  const root = join(parentDir, "packs", PACK_FIXTURE_NAME, PACK_FIXTURE_VERSION);
  mkdirSync(root, { recursive: true });
  const packToml = [
    "[pack]",
    `name = "${PACK_FIXTURE_NAME}"`,
    `version = "${PACK_FIXTURE_VERSION}"`,
    'description = "Hermetic PJAN-57 release-gate fixture."',
    "",
    "[freeform]",
    `skills = [${PACK_FIXTURE_SKILLS.map((name) => JSON.stringify(name)).join(", ")}]`,
    "",
    "[policy]",
    "sealed = true",
    "",
  ].join("\n");
  writeFileSync(join(root, "pack.toml"), packToml, "utf8");
  for (const name of PACK_FIXTURE_SKILLS) {
    const skillDir = join(root, name);
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(join(skillDir, "SKILL.md"), `---\nname: ${name}\n---\n# ${name}\n`, "utf8");
  }
  const payload = [
    "pack.toml",
    ...PACK_FIXTURE_SKILLS.map((name) => `${name}/SKILL.md`),
  ].sort();
  writeFileSync(
    join(root, "SHA256SUMS"),
    `${payload.map((path) => `${sha256(readFileSync(join(root, path)))}  ${path}`).join("\n")}\n`,
    "utf8",
  );
  return root;
}

export function createBmadInstallerFixture(parentDir) {
  const executable = join(parentDir, "bin", "bmad-method-fixture");
  mkdirSync(dirname(executable), { recursive: true });
  writeFileSync(executable, `#!${process.execPath}
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";

const version = ${JSON.stringify(BMAD_INSTALLER_FIXTURE_VERSION)};
const args = process.argv.slice(2);
if (args.length === 1 && args[0] === "--version") {
  process.stdout.write(version + "\\n");
  process.exit(0);
}
if (args[0] !== "install") {
  process.stderr.write("expected install subcommand\\n");
  process.exit(2);
}
const valueAfter = (flag) => {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : undefined;
};
const target = valueAfter("--directory");
const modulesValue = valueAfter("--modules") || "core";
const projectSetting = valueAfter("--set");
if (!target) {
  process.stderr.write("missing --directory\\n");
  process.exit(2);
}
const failOnce = process.env.PJ_BMAD_FIXTURE_FAIL_ONCE_STATE;
if (failOnce && !existsSync(failOnce)) {
  mkdirSync(dirname(failOnce), { recursive: true });
  writeFileSync(failOnce, "failed once\\n");
  process.stderr.write("injected hermetic BMAD install failure\\n");
  process.exit(42);
}
const projectName = projectSetting?.startsWith("core.project_name=")
  ? projectSetting.slice("core.project_name=".length)
  : basename(resolve(target));
const modules = [...new Set(["core", ...modulesValue.split(",").filter((name) => name && name !== "core")])];
// The real installer writes its skills into .agents/skills AND into every
// --tools root. bmad.cli-roots audits exactly that, so a fixture that only
// wrote _bmad/ would pass the install and fail the postcondition — which is
// not a property of the code under test, only of the fake.
const toolRoots = {
  "claude-code": ".claude",
  codex: ".codex",
  gemini: ".gemini",
  "github-copilot": ".copilot",
  opencode: ".opencode",
  "kimi-code": ".kimi-code",
};
const installedSkills = ["bmad-agent-pm", "bmad-architecture", "bmad-help"];
const skillRoots = [
  join(target, ".agents", "skills"),
  ...(valueAfter("--tools") || "")
    .split(",")
    .map((tool) => toolRoots[tool.trim()])
    .filter(Boolean)
    .map((root) => join(target, root, "skills")),
];
for (const skillRoot of skillRoots) {
  for (const skill of installedSkills) {
    mkdirSync(join(skillRoot, skill), { recursive: true });
    writeFileSync(
      join(skillRoot, skill, "SKILL.md"),
      "---\\nname: " + skill + "\\n---\\n# " + skill + "\\n",
    );
  }
}
const bmadRoot = join(target, "_bmad");
mkdirSync(join(bmadRoot, "_config"), { recursive: true });
for (const moduleName of modules) {
  mkdirSync(join(bmadRoot, moduleName), { recursive: true });
  writeFileSync(join(bmadRoot, moduleName, "config.yaml"), "project_name: " + JSON.stringify(projectName) + "\\n");
}
writeFileSync(
  join(bmadRoot, "config.toml"),
  "[core]\\nproject_name = " + JSON.stringify(projectName) + "\\n\\n" +
    modules.filter((name) => name !== "core").map((name) => "[modules." + name + "]\\n").join("\\n"),
);
writeFileSync(
  join(bmadRoot, "_config", "manifest.yaml"),
  "installation:\\n  version: " + version + "\\nmodules:\\n" +
    modules.map((name) => "  - name: " + name + "\\n").join(""),
);
process.stdout.write("installed BMAD fixture " + version + "\\n");
`, "utf8");
  chmodSync(executable, 0o755);
  return executable;
}
