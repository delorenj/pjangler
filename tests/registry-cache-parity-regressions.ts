// Contract section 2 step 3: `~/.agents/.cache/registries/<sanitized-url>` is
// addressed by three independent surfaces. The two repository-contained
// surfaces are always compared; Skillex joins only when PJ_SKILLEX_ROOT
// explicitly selects its checkout —
//
//   * pjangler        src/parity/index.ts        registryCacheDirName()
//   * sync-skills.py  registry_cache_dir()
//   * skillex         src/skillex/paths.py       sanitize_registry_url()
//
// If any two disagree, one manifest resolves to two different registry
// checkouts, and the same pack gets SHA256SUMS-verified by one surface and
// zero-integrity-checked by another. That regression shipped once: skillex
// produced `https-github.com-delorenj-skillex.git` while both engines produced
// `https___github_com_delorenj_skillex_git`, so `sync-skills.py` served bmad
// out of a stale unsealed clone while skillex served it sealed from
// ~/code/skillex. This suite is the tripwire.

import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { registryCacheDirName } from "../src/parity/index";

const pjanglerRoot = resolve(import.meta.dirname, "..");

const CANONICAL_URL = "https://github.com/delorenj/skillex.git";
const CANONICAL_NAME = "https___github_com_delorenj_skillex_git";

// Deliberately nasty: separators, dot segments, credentials, query/fragment.
const URLS = [
  CANONICAL_URL,
  "https://github.com/delorenj/skillex",
  "git@github.com:delorenj/skillex.git",
  "ssh://git@github.com:22/delorenj/skillex.git",
  "https://example.com/a/b/../c.git",
  pathToFileURL(join(tmpdir(), "registry-cache-skillex-fixture")).href,
  "https://user:tok@example.com/x.git?ref=main#frag",
  "HTTPS://GitHub.com/DeLorenJ/Skillex.GIT",
  "../../../etc/passwd",
];

const syncSkills = resolve(
  process.env.PJ_SYNC_SKILLS_PATH?.trim() ||
    join(pjanglerRoot, "templates", "commonproject", "template", ".mise", "scripts", "sync-skills.py")
);
const explicitSkillexRoot = process.env.PJ_SKILLEX_ROOT?.trim();
const skillexRoot = explicitSkillexRoot ? resolve(explicitSkillexRoot) : undefined;

function python(code: string): string {
  const run = spawnSync("python3", ["-c", code], { encoding: "utf8" });
  assert.equal(run.status, 0, `python3 failed:\n${run.stdout}${run.stderr}`);
  return run.stdout.trim();
}

function syncSkillsNames(urls: string[]): string[] {
  const payload = JSON.stringify(urls);
  return JSON.parse(
    python(
      [
        "import importlib.util, json",
        `spec = importlib.util.spec_from_file_location('sync_skills', ${JSON.stringify(syncSkills)})`,
        "m = importlib.util.module_from_spec(spec)",
        "spec.loader.exec_module(m)",
        `print(json.dumps([m.registry_cache_dir(u).name for u in json.loads(${JSON.stringify(payload)})]))`,
      ].join("\n")
    )
  );
}

function skillexNames(urls: string[]): string[] {
  assert.ok(skillexRoot, "PJ_SKILLEX_ROOT is required for the optional Skillex parity layer");
  const payload = JSON.stringify(urls);
  return JSON.parse(
    python(
      [
        "import json, sys",
        `sys.path.insert(0, ${JSON.stringify(join(skillexRoot, "src"))})`,
        "from skillex.paths import sanitize_registry_url",
        `print(json.dumps([sanitize_registry_url(u) for u in json.loads(${JSON.stringify(payload)})]))`,
      ].join("\n")
    )
  );
}

// --- pjangler's own surface ------------------------------------------------

assert.equal(registryCacheDirName(CANONICAL_URL), CANONICAL_NAME);
for (const url of URLS) {
  const name = registryCacheDirName(url);
  assert.match(name, /^[a-zA-Z0-9_]+$/, `not one safe path component: ${url} -> ${name}`);
  assert.equal(name.includes("/"), false);
  assert.equal(name === "." || name === "..", false);
}

// --- sync-skills.py --------------------------------------------------------

assert.equal(existsSync(syncSkills), true, `sync-skills.py missing: ${syncSkills}`);
const fromSync = syncSkillsNames(URLS);
URLS.forEach((url, i) => {
  assert.equal(
    fromSync[i],
    registryCacheDirName(url),
    `sync-skills.py disagrees with pjangler for ${url}: ${fromSync[i]} vs ${registryCacheDirName(url)}`
  );
});

// --- skillex (optional cross-repo layer) -----------------------------------

if (skillexRoot) {
  assert.equal(
    existsSync(join(skillexRoot, "src", "skillex", "paths.py")),
    true,
    `explicit Skillex checkout is invalid: ${skillexRoot}`,
  );
  const fromSkillex = skillexNames(URLS);
  URLS.forEach((url, i) => {
    assert.equal(
      fromSkillex[i],
      registryCacheDirName(url),
      `skillex disagrees with pjangler for ${url}: ${fromSkillex[i]} vs ${registryCacheDirName(url)}`,
    );
  });
} else {
  console.log("optional Skillex registry-cache parity skipped; set PJ_SKILLEX_ROOT to enable it");
}

// --- repository-contained parity on the URL that actually ships ------------

const canonicalNames = [registryCacheDirName(CANONICAL_URL), syncSkillsNames([CANONICAL_URL])[0]];
if (skillexRoot) canonicalNames.push(skillexNames([CANONICAL_URL])[0]);
assert.deepEqual(
  canonicalNames,
  canonicalNames.map(() => CANONICAL_NAME),
  "every enabled surface must name the same registry cache directory",
);

console.log("registry-cache parity regressions passed");
