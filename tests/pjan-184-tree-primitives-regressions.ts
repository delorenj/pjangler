import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { hermeticEnv } from "./helpers/hermetic-env.mjs";
import {
  chmodSync, existsSync, lstatSync, lutimesSync, utimesSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { changedTreePaths, excludedFromTreeSnapshot, snapshotTree } from "../src/utils/tree-diff";
import {
  backupToSnapshot, captureScopedRoots, captureTreeBackup, restoreSingleEntry, restoreTreeBackup,
} from "../src/utils/tree-restore";
import { runG33Companion } from "../src/bmad/companion";
import { evictReservedModuleEntries, isLegacyReservedModuleEntry, stripReservedModuleEntries } from "../src/bmad/reserved-modules";
import YAML from "yaml";

// PJAN-184: direct regressions for the byte-exact tree primitives (tree-diff,
// tree-restore), the g33 adapter resolver in companion.ts and the manifest
// line editor in reserved-modules.ts. The big BMAD
// suites reach them only through whole updates; the error, ancestor and
// replace-in-place branches below are the ones a rollback depends on and no
// update scenario provokes. Everything is real: real files, real modes, real
// symlinks, a real fifo, a real resolver subprocess. Scratch lives in /tmp with
// GIT_CEILING_DIRECTORIES pinned.
const scratch = realpathSync(mkdtempSync("/tmp/pjan-184-tree-primitives-"));
process.env.GIT_CEILING_DIRECTORIES = "/tmp";
const isRoot = typeof process.getuid === "function" && process.getuid() === 0;
const put = (path: string, text: string, mode?: number) => {
  mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, text); if (mode !== undefined) chmodSync(path, mode);
};
let seq = 0;
const fresh = (label: string) => join(scratch, `${label}-${++seq}`);
const codeOf = (action: () => unknown): string | undefined => {
  try { action(); } catch (error) { return (error as NodeJS.ErrnoException).code; }
  return undefined;
};
const sorted = (snapshot: Map<string, string>) => [...snapshot.entries()].sort(([a], [b]) => a.localeCompare(b));

try {
  // 1. snapshotTree: an entry it may not read is a fingerprint under tolerateUnreadable and a throw otherwise.
  if (!isRoot) {
    const dir = fresh("unreadable");
    put(join(dir, "locked-file.txt"), "secret", 0o000);
    put(join(dir, "locked-dir", "inner.txt"), "inner");
    chmodSync(join(dir, "locked-dir"), 0o000);
    put(join(dir, "ok.txt"), "fine");
    try {
      assert.equal(codeOf(() => snapshotTree(dir)), "EACCES", "strict mode throws on an unreadable file");
      const tolerant = snapshotTree(dir, { tolerateUnreadable: true });
      assert.match(tolerant.get("locked-file.txt") ?? "", /^file:unreadable:EACCES:0:6:/, "unreadable file -> metadata fingerprint (mode 0, size 6)");
      assert.match(tolerant.get("locked-dir") ?? "", /^dir:unreadable:EACCES:0:/, "unreadable dir -> metadata fingerprint");
      assert.ok(!tolerant.has("locked-dir/inner.txt"), "an unreadable dir is not entered");
      assert.match(tolerant.get("ok.txt") ?? "", /^file:[0-9a-f]{64}:\d+$/, "readable files keep their sha256 form");
      // The fingerprint moves when the entry changes, so a write to it is still a change.
      chmodSync(join(dir, "locked-file.txt"), 0o200);
      const changed = snapshotTree(dir, { tolerateUnreadable: true });
      assert.deepEqual(changedTreePaths(dir, tolerant, changed), [join(dir, "locked-file.txt")]);
      // lstat itself denied: a scoped root beneath a non-searchable dir.
      chmodSync(join(dir, "locked-file.txt"), 0o600);
      assert.equal(codeOf(() => snapshotTree(dir, { roots: ["locked-dir/inner.txt"] })), "EACCES", "strict: lstat denied is thrown");
      assert.equal(snapshotTree(dir, { roots: ["locked-dir/inner.txt"], tolerateUnreadable: true }).get("locked-dir/inner.txt"), "unreadable:EACCES");
    } finally { chmodSync(join(dir, "locked-dir"), 0o700); }
    console.log("PASS tree-diff: unreadable entries are fingerprints under tolerateUnreadable and errors otherwise");
  }

  // 2. snapshotTree: exclusions, other kinds, and scoped roots behind non-directory ancestors.
  {
    const dir = fresh("shapes");
    put(join(dir, "kept.txt"), "k");
    put(join(dir, "node_modules", "dep", "index.js"), "x");
    put(join(dir, "agents", "hermes", "pm", "runtime", "state.sqlite"), "db");
    put(join(dir, "agents", "hermes", "pm", "SOUL.md"), "soul");
    put(join(dir, "live.db"), "db"); put(join(dir, "live.db-wal"), "wal");
    put(join(dir, "plain.db"), "db");
    put(join(dir, "daemon.pid"), "1");
    mkdirSync(join(dir, ".git")); put(join(dir, ".git", "HEAD"), "ref");
    assert.equal(spawnSync("mkfifo", [join(dir, "pipe")], { env: hermeticEnv() }).status, 0, "mkfifo");
    symlinkSync("kept.txt", join(dir, "link"));
    put(join(dir, "file-ancestor"), "i am a file");
    symlinkSync(join(dir, "kept.txt"), join(dir, "link-ancestor"));
    const keys = [...snapshotTree(dir).keys()].sort();
    assert.deepEqual(keys, [".", "agents", "agents/hermes", "agents/hermes/pm", "agents/hermes/pm/SOUL.md", "file-ancestor", "kept.txt", "link", "link-ancestor", "pipe", "plain.db"],
      `runtime state, .git, node_modules and a journaled .db are excluded; a bare .db and a fifo are not: ${keys}`);
    assert.match(snapshotTree(dir).get("pipe") ?? "", /^other:\d+$/, "a fifo is recorded as `other`");
    assert.equal(snapshotTree(dir).get("link"), "link:kept.txt");
    assert.equal(excludedFromTreeSnapshot("live.db", join(dir, "live.db")), true);
    assert.equal(excludedFromTreeSnapshot("plain.db", join(dir, "plain.db")), false);
    assert.equal(excludedFromTreeSnapshot("live.db"), false, "without a full path the sibling check cannot run");
    // A scoped root under a file or symlink ancestor records the ancestor and stops; an absent ancestor records nothing.
    const scoped = snapshotTree(dir, { roots: ["file-ancestor/deeper/x", "link-ancestor/deeper", "missing/deeper", "kept.txt"] });
    assert.deepEqual(sorted(scoped).map(([key]) => key), ["file-ancestor", "kept.txt", "link-ancestor"]);
    console.log("PASS tree-diff: exclusions, fifo, and scoped roots behind file/symlink/absent ancestors");
  }

  // 3. captureTreeBackup: strict capture fails loudly, a live capture tolerates a vanished entry.
  {
    const dir = fresh("capture");
    put(join(dir, "gone.txt"), "soon gone"); put(join(dir, "stays.txt"), "stays");
    assert.equal(captureTreeBackup(join(dir, "never-existed")).size, 0, "an absent root captures nothing");
    const vanish = (full: string) => { if (full.endsWith("gone.txt")) rmSync(full); };
    assert.equal(codeOf(() => captureTreeBackup(dir, dir, new Map(), { beforeRead: vanish })), "ENOENT", "strict capture: a racing delete blocks");
    put(join(dir, "gone.txt"), "soon gone");
    const live = captureTreeBackup(dir, dir, new Map(), { tolerateVanished: true, beforeRead: vanish });
    assert.ok(!live.has("gone.txt"), "tolerateVanished: the vanished entry is absent, not stale");
    assert.ok(live.has("stays.txt") && live.has("."));
    const excluded = captureTreeBackup(dir, dir, new Map(), { exclude: (rel) => rel === "stays.txt" });
    assert.ok(!excluded.has("stays.txt"), "exclude keeps a path out of the capture");
    if (!isRoot) {
      put(join(dir, "sealed", "x.txt"), "x"); chmodSync(join(dir, "sealed"), 0o000);
      try { assert.equal(codeOf(() => captureTreeBackup(dir, join(dir, "sealed", "x.txt"))), "EACCES", "a non-ENOENT lstat failure is rethrown"); }
      finally { chmodSync(join(dir, "sealed"), 0o700); }
    }
    console.log("PASS tree-restore: strict vs tolerateVanished capture, exclude, absent root, unreadable lstat");
  }

  // 4. captureScopedRoots describes the same paths as snapshotTree's scoped walk.
  {
    const dir = fresh("scoped");
    put(join(dir, ".claude", "skills", "a", "SKILL.md"), "a");
    put(join(dir, "file-ancestor"), "file");
    symlinkSync("elsewhere", join(dir, "link-ancestor"));
    put(join(dir, "outside.txt"), "not scoped");
    const roots = [".claude/skills", "file-ancestor/deeper", "link-ancestor/deeper", "missing/deeper"];
    const backup = captureScopedRoots(dir, roots);
    assert.deepEqual([...backup.keys()].sort(), [".claude/skills", ".claude/skills/a", ".claude/skills/a/SKILL.md", "file-ancestor", "link-ancestor"]);
    assert.equal(backup.get("link-ancestor")?.kind, "link");
    assert.equal(backup.get("file-ancestor")?.kind, "file");
    assert.deepEqual(sorted(backupToSnapshot(backup)), sorted(snapshotTree(dir, { roots })), "backupToSnapshot(capture) === snapshotTree for the same scope");
    if (!isRoot) {
      put(join(dir, "sealed", "x", "y.txt"), "y"); chmodSync(join(dir, "sealed"), 0o000);
      try { assert.equal(codeOf(() => captureScopedRoots(dir, ["sealed/x/y.txt"])), "EACCES", "an ancestor that cannot be lstat'd is an error, not an absence"); }
      finally { chmodSync(join(dir, "sealed"), 0o700); }
    }
    console.log("PASS tree-restore: scoped capture stops at file/symlink/absent ancestors and matches snapshotTree");
  }

  // 5. restoreSingleEntry replaces what is in the way and leaves what already matches untouched.
  {
    const dir = fresh("single");
    // A rewrite stamps a fresh mtime and inodes are reused at once, so "left alone" is proven with an mtime parked in the past.
    const past = new Date("2020-01-01T00:00:00Z");
    const mtime = (rel: string) => lstatSync(join(dir, rel)).mtimeMs;
    put(join(dir, "same.txt"), "same", 0o644);
    const same = captureTreeBackup(dir, join(dir, "same.txt"), new Map()).get("same.txt")!;
    utimesSync(join(dir, "same.txt"), past, past);
    restoreSingleEntry(dir, "same.txt", same);
    assert.equal(mtime("same.txt"), past.getTime(), "a byte- and mode-identical file is not rewritten");
    writeFileSync(join(dir, "same.txt"), "drift");
    restoreSingleEntry(dir, "same.txt", same);
    assert.equal(readFileSync(join(dir, "same.txt"), "utf8"), "same", "drifted bytes are restored");
    chmodSync(join(dir, "same.txt"), 0o600);
    restoreSingleEntry(dir, "same.txt", same);
    assert.equal(statSync(join(dir, "same.txt")).mode & 0o7777, 0o644, "a mode-only drift is restored");

    // read-only file (a git pack object is 0444) replaced via unlink
    put(join(dir, "pack.idx"), "original", 0o444);
    const pack = captureTreeBackup(dir, join(dir, "pack.idx"), new Map()).get("pack.idx")!;
    chmodSync(join(dir, "pack.idx"), 0o644); writeFileSync(join(dir, "pack.idx"), "mutated"); chmodSync(join(dir, "pack.idx"), 0o444);
    restoreSingleEntry(dir, "pack.idx", pack);
    assert.equal(readFileSync(join(dir, "pack.idx"), "utf8"), "original");
    assert.equal(statSync(join(dir, "pack.idx")).mode & 0o7777, 0o444);

    // file entry, but a directory / symlink now occupies the path
    put(join(dir, "wasfile"), "was a file");
    const wasFile = captureTreeBackup(dir, join(dir, "wasfile"), new Map()).get("wasfile")!;
    rmSync(join(dir, "wasfile")); mkdirSync(join(dir, "wasfile")); put(join(dir, "wasfile", "child"), "c");
    restoreSingleEntry(dir, "wasfile", wasFile);
    assert.equal(readFileSync(join(dir, "wasfile"), "utf8"), "was a file", "a directory in the way of a file is removed");
    rmSync(join(dir, "wasfile")); symlinkSync("same.txt", join(dir, "wasfile"));
    restoreSingleEntry(dir, "wasfile", wasFile);
    assert.ok(!lstatSync(join(dir, "wasfile")).isSymbolicLink() && readFileSync(join(dir, "wasfile"), "utf8") === "was a file", "a symlink in the way of a file is replaced, not written through");
    assert.equal(readFileSync(join(dir, "same.txt"), "utf8"), "same", "the symlink target was not written through");

    // link entry: same target untouched, different target / file / directory replaced
    symlinkSync("target-a", join(dir, "lnk"));
    const link = captureTreeBackup(dir, join(dir, "lnk"), new Map()).get("lnk")!;
    lutimesSync(join(dir, "lnk"), past, past);
    restoreSingleEntry(dir, "lnk", link);
    assert.equal(mtime("lnk"), past.getTime(), "a matching symlink is left alone");
    rmSync(join(dir, "lnk")); symlinkSync("target-b", join(dir, "lnk"));
    restoreSingleEntry(dir, "lnk", link);
    assert.equal(readlinkSync(join(dir, "lnk")), "target-a", "a retargeted symlink is repointed");
    rmSync(join(dir, "lnk")); put(join(dir, "lnk"), "now a file");
    restoreSingleEntry(dir, "lnk", link);
    assert.equal(readlinkSync(join(dir, "lnk")), "target-a", "a file in the way of a symlink is replaced");
    rmSync(join(dir, "lnk")); put(join(dir, "lnk", "child"), "now a dir");
    restoreSingleEntry(dir, "lnk", link);
    assert.equal(readlinkSync(join(dir, "lnk")), "target-a", "a directory in the way of a symlink is replaced");
    rmSync(join(dir, "lnk")); restoreSingleEntry(dir, "deep/er/lnk", link);
    assert.equal(readlinkSync(join(dir, "deep", "er", "lnk")), "target-a", "missing parents are created");

    // dir entry: a file or a symlink in the way is replaced by a real dir with the recorded mode
    mkdirSync(join(dir, "d")); chmodSync(join(dir, "d"), 0o750);
    const dirEntry = captureTreeBackup(dir, join(dir, "d"), new Map()).get("d")!;
    rmSync(join(dir, "d", ""), { recursive: true }); put(join(dir, "d"), "a file");
    restoreSingleEntry(dir, "d", dirEntry);
    assert.ok(lstatSync(join(dir, "d")).isDirectory(), "a file in the way of a directory is replaced");
    rmSync(join(dir, "d"), { recursive: true }); mkdirSync(join(dir, "real")); symlinkSync("real", join(dir, "d"));
    restoreSingleEntry(dir, "d", dirEntry);
    assert.ok(lstatSync(join(dir, "d")).isDirectory() && !lstatSync(join(dir, "d")).isSymbolicLink(), "a symlink-to-dir is replaced by a real directory");
    assert.equal(statSync(join(dir, "d")).mode & 0o7777, 0o750);
    assert.ok(existsSync(join(dir, "real")), "the symlink's target is untouched");
    chmodSync(join(dir, "d"), 0o700); rmSync(join(dir, "d"), { recursive: true }); restoreSingleEntry(dir, "d", dirEntry);
    assert.equal(statSync(join(dir, "d")).mode & 0o7777, 0o750, "an absent directory is recreated with its mode");
    console.log("PASS tree-restore: restoreSingleEntry replaces obstructions, leaves matching entries untouched, keeps modes");
  }

  // 6. restoreTreeBackup rewinds a whole tree to the byte: content, modes (incl. read-only dirs), links, deletions and additions.
  {
    const dir = fresh("whole");
    put(join(dir, "a.txt"), "a", 0o644);
    put(join(dir, "nested", "deep", "b.txt"), "b", 0o600);
    put(join(dir, "ro", "c.txt"), "c", 0o444);
    chmodSync(join(dir, "ro"), 0o500);
    symlinkSync("a.txt", join(dir, "alias"));
    put(join(dir, "node_modules", "kept", "x.js"), "runtime state is outside the backup");
    const baseline = snapshotTree(dir);
    const backup = captureTreeBackup(dir);
    try {
      // damage: edit, delete a read-only dir's file and the dir, add files/dirs/links, retarget a link
      writeFileSync(join(dir, "a.txt"), "edited");
      rmSync(join(dir, "nested"), { recursive: true });
      chmodSync(join(dir, "ro"), 0o700); rmSync(join(dir, "ro"), { recursive: true });
      rmSync(join(dir, "alias")); symlinkSync("elsewhere", join(dir, "alias"));
      put(join(dir, "added", "deep", "new.txt"), "new"); symlinkSync("nope", join(dir, "added", "dangling"));
      put(join(dir, "added-top.txt"), "new");
      put(join(dir, "node_modules", "kept", "newer.js"), "a live daemon wrote this");
      assert.notDeepEqual(sorted(snapshotTree(dir)), sorted(baseline), "the damage is real");
      restoreTreeBackup(dir, backup);
      assert.deepEqual(sorted(snapshotTree(dir)), sorted(baseline), "the tree is back to the byte, mode and link target");
      assert.ok(existsSync(join(dir, "node_modules", "kept", "newer.js")), "excluded runtime state is neither captured nor rewound");
      assert.equal(statSync(join(dir, "ro")).mode & 0o7777, 0o500, "a read-only dir is restored read-only");

      // a read-only dir that gained a child after the backup: the child is removed anyway
      chmodSync(join(dir, "ro"), 0o700); put(join(dir, "ro", "extra.txt"), "x"); chmodSync(join(dir, "ro"), 0o500);
      restoreTreeBackup(dir, backup);
      assert.deepEqual(sorted(snapshotTree(dir)), sorted(baseline), "removal inside a read-only dir works (owner-writable while restoring)");
      assert.ok(!existsSync(join(dir, "ro", "extra.txt")));

      // fifos are invisible: never captured, never deleted
      assert.equal(spawnSync("mkfifo", [join(dir, "pipe")], { env: hermeticEnv() }).status, 0);
      restoreTreeBackup(dir, backup);
      assert.ok(existsSync(join(dir, "pipe")), "a fifo created after the backup survives the restore");
      assert.ok(!backup.has("pipe"));
    } finally { try { chmodSync(join(dir, "ro"), 0o700); } catch { /* removed */ } }
    console.log("PASS tree-restore: whole-tree restore returns content, modes, links and deletions; runtime state and fifos are left alone");
  }

  // 7. The g33 adapter resolver: installed package specifiers resolve from the PROJECT, with a PJangler fallback and a clear failure.
  {
    const adapterSource = `const r=(status,summary,evidence=[])=>({schemaVersion:1,status,summary,details:[],evidence});
export function companion(req){
  if(req.operation==='observe')return r('installed','installed',['from the package']);
  if(req.operation==='plan')return r('unchanged','converged');
  return r('unchanged','nothing to do');
}`;
    const project = (name: string, adapter: { module: string; exportName: string }) => {
      const dir = fresh(name);
      put(join(dir, ".project.json"), `${JSON.stringify({ project_id: name, ticket_provider: { type: "plane", workspace: "33god", state: "linked", board_id: "b" }, bmad: { companion: { adapter } } })}\n`);
      return dir;
    };
    // an installed package, found through its `exports` map, relative to the project
    const installed = project("pkg-installed", { module: "fake-g33-owner", exportName: "companion" });
    put(join(installed, "node_modules", "fake-g33-owner", "package.json"), JSON.stringify({ name: "fake-g33-owner", version: "1.0.0", type: "module", exports: { ".": "./lib/entry.mjs" } }));
    put(join(installed, "node_modules", "fake-g33-owner", "lib", "entry.mjs"), adapterSource);
    const ok = await runG33Companion(installed, false, "repair");
    assert.equal(ok.status, "unchanged", JSON.stringify(ok));
    assert.deepEqual(ok.adapter, { module: "fake-g33-owner", exportName: "companion" });
    assert.deepEqual(ok.evidence, ["from the package"]);

    // not installed anywhere: both resolution attempts are reported
    const missing = project("pkg-missing", { module: "definitely-not-installed-g33-owner", exportName: "companion" });
    const gone = await runG33Companion(missing, true, "audit");
    assert.equal(gone.status, "unavailable", JSON.stringify(gone));
    assert.match(gone.details.join("\n"), /Project ESM resolution failed: [\s\S]*PJangler ESM resolution failed: /, gone.details.join("\n"));

    // not in the project but resolvable from PJangler's own tree: the fallback finds it, and the export check still applies
    const fallback = project("pkg-fallback", { module: "esbuild", exportName: "definitelyNotAnExport" });
    const viaPjangler = await runG33Companion(fallback, true, "audit");
    assert.equal(viaPjangler.status, "error", JSON.stringify(viaPjangler));
    assert.match(viaPjangler.details.join("\n"), /Configured g33 export definitelyNotAnExport is not callable/);

    // a URL-ish or scheme-prefixed specifier is refused before any resolution
    for (const module of ["https://example.invalid/owner.mjs", "node:fs", "data:text/javascript,export{}"]) {
      const refused = await runG33Companion(project("pkg-scheme", { module, exportName: "companion" }), true, "audit");
      assert.equal(refused.status, "unavailable", `${module}: ${JSON.stringify(refused)}`);
      assert.match(refused.details.join("\n"), /Use a local source path or installed package specifier for g33/, module);
    }
    console.log("PASS companion: package specifiers resolve from the project, fall back to PJangler, and refuse schemes");
  }
  // 8. The manifest line editor drops only legacy reserved-name records and keeps every other byte.
  {
    const legacy = "  - name: custom\n    version: null\n    source: unknown\n";
    const real = "  - name: bmm\n    version: 6.12.0\n    source: built-in\n";
    // A header comment, a blank line and a comment after the list, and the keys around it must survive verbatim.
    const manifest = `installation:\n  version: 6.12.0\nmodules:  # installed\n${real}${legacy}\n# after the list\nides:\n  - claude\n`;
    const stripped = stripReservedModuleEntries(manifest)!;
    assert.deepEqual(stripped.evicted, ["custom"]);
    assert.equal(stripped.text, `installation:\n  version: 6.12.0\nmodules:  # installed\n${real}\n# after the list\nides:\n  - claude\n`);
    // Nothing legacy, no modules key, or a non-list value: undefined, never a rewrite.
    assert.equal(stripReservedModuleEntries(`modules:\n${real}`), undefined, "no legacy entry");
    assert.equal(stripReservedModuleEntries("ides:\n  - claude\n"), undefined, "no modules key");
    assert.equal(stripReservedModuleEntries("modules: []\n"), undefined, "an inline value is not a block list");
    assert.equal(stripReservedModuleEntries("modules:\nother: 1\n"), undefined, "a sibling key right after modules");
    // A mapping-style item list ends at the first line left of the items; a bare `- custom` is the operator's own.
    assert.equal(stripReservedModuleEntries("modules:\n  - custom\nnext: 1\n"), undefined, "a bare scalar item is a hand-written selection");
    assert.deepEqual(stripReservedModuleEntries(`modules:\n${legacy}next: 1\n`)!.evicted, ["custom"]);
    assert.equal(stripReservedModuleEntries(`modules:\n${legacy}next: 1\n`)!.text, "modules:\nnext: 1\n");
    // An item that is not valid YAML is skipped and the rest of the list is still processed.
    const broken = `modules:\n  - name: [unclosed\n${legacy}`;
    assert.deepEqual(stripReservedModuleEntries(broken)!.evicted, ["custom"], "an unparseable item does not hide a legacy one");
    assert.equal(stripReservedModuleEntries(broken)!.text, "modules:\n  - name: [unclosed\n");
    // The record shape predicate.
    assert.equal(isLegacyReservedModuleEntry({ name: "custom", version: "", source: "Unknown" }), true, "empty version and a case-insensitive `unknown` source");
    assert.equal(isLegacyReservedModuleEntry({ name: "custom", version: "1.0.0" }), false);
    assert.equal(isLegacyReservedModuleEntry({ name: "custom", source: "built-in" }), false);
    assert.equal(isLegacyReservedModuleEntry({ name: "bmm" }), false, "not a reserved name");
    assert.equal(isLegacyReservedModuleEntry(["custom"]), false);
    assert.equal(isLegacyReservedModuleEntry(null), false);

    // PJAN-185: a comment inside the modules list used to hide legacy entries (split lines keep
    // their line ending, which the blank/comment test never spanned), blocking the eviction that
    // keeps the BMAD installer from deleting _bmad/custom.
    {
      const crlf = (text: string) => text.replace(/\n/g, "\r\n");
      // A comment between `modules:` and the first item: the entry below it is evicted.
      const lead = `modules:\n  # note\n${legacy}ides:\n  - claude\n`;
      assert.deepEqual(stripReservedModuleEntries(lead)!.evicted, ["custom"]);
      assert.equal(stripReservedModuleEntries(lead)!.text, "modules:\n  # note\nides:\n  - claude\n");
      // A comment between items at item indent no longer ends the block early.
      const mid = `modules:\n${real}  # note\n${legacy}`;
      assert.deepEqual(stripReservedModuleEntries(mid)!.evicted, ["custom"]);
      assert.equal(stripReservedModuleEntries(mid)!.text, `modules:\n${real}  # note\n`);
      // CRLF manifests: comments recognized, and the output keeps CRLF byte for byte.
      assert.deepEqual(stripReservedModuleEntries(crlf(lead))!.evicted, ["custom"]);
      assert.equal(stripReservedModuleEntries(crlf(lead))!.text, crlf("modules:\n  # note\nides:\n  - claude\n"));
      // The last line without its newline (comment or entry) is still handled.
      assert.deepEqual(stripReservedModuleEntries(`modules:\n  # note\n${legacy.replace(/\n$/, "")}`)!.evicted, ["custom"]);
      assert.equal(stripReservedModuleEntries(`modules:\n${legacy}# section note\n${real}`)!.text, `modules:\n# section note\n${real}`, "an unindented comment between items is kept");

      // Comment ownership: a comment at or left of the item indent annotates the NEXT entry and
      // always survives -- above a kept entry, and even above an evicted one.
      assert.equal(stripReservedModuleEntries(`modules:\n${legacy}  # the real module\n${real}`)!.text, `modules:\n  # the real module\n${real}`);
      assert.equal(stripReservedModuleEntries(`modules:\n${real}  # legacy junk\n${legacy}`)!.text, `modules:\n${real}  # legacy junk\n`);
      assert.equal(stripReservedModuleEntries(`modules:\n${legacy}  # odd spot\n  - name: scripts\n    version: null\n    source: unknown\nnext: 1\n`)!.text,
        "modules:\n  # odd spot\nnext: 1\n", "a comment between two evicted entries is kept");
      // A comment deeper than the item indent is inside the previous item's body and follows it:
      assert.equal(stripReservedModuleEntries(`modules:\n${legacy}    # body trailer\n${real}`)!.text, `modules:\n${real}`);
      assert.equal(stripReservedModuleEntries(`modules:\n  - name: custom\n    # why null\n    version: null\n    source: unknown\n${real}`)!.text, `modules:\n${real}`);
      // A bare `- custom` scalar stays an operator selection, byte for byte, comment or not.
      assert.equal(stripReservedModuleEntries("modules:\n  # pick\n  - custom\nnext: 1\n"), undefined);
      assert.equal(stripReservedModuleEntries(`modules:\n${legacy}  - custom\n`)!.text, "modules:\n  - custom\n");

      // Parse equality: the edited manifest parses as the original minus exactly the evicted
      // entry, every other key unchanged, comments and all.
      const original = "installation:\n  version: 6.12.0\nmodules:\n  # lead\n" +
        `${real}  # kept note\n${legacy}    # deep trailer\nides:\n  - claude\n`;
      const edited = stripReservedModuleEntries(original)!;
      assert.deepEqual(edited.evicted, ["custom"]);
      const before = YAML.parse(original) as { installation: unknown; modules: Array<{ name: string }>; ides: unknown };
      const after = YAML.parse(edited.text) as typeof before;
      assert.deepEqual(after.installation, before.installation);
      assert.deepEqual(after.ides, before.ides);
      assert.deepEqual(after.modules, before.modules.filter((module) => module.name !== "custom"));
    }

    // evictReservedModuleEntries: dry run reports without writing; a real run writes; an unreadable manifest is left alone.
    const repo = fresh("manifest"); const path = join(repo, "_bmad", "_config", "manifest.yaml");
    assert.deepEqual(evictReservedModuleEntries(repo, false), { evicted: [], changedFiles: [], details: [] }, "no manifest");
    put(path, manifest);
    const dry = evictReservedModuleEntries(repo, true);
    assert.deepEqual(dry.evicted, ["custom"]); assert.deepEqual(dry.changedFiles, [path]); assert.equal(dry.original, manifest);
    assert.match(dry.details.join("\n"), /would remove legacy manifest module "custom"[\s\S]*_bmad\/custom/);
    assert.equal(readFileSync(path, "utf8"), manifest, "a dry run writes nothing");
    const wet = evictReservedModuleEntries(repo, false);
    assert.match(wet.details.join("\n"), /^removed legacy manifest module "custom"/);
    assert.equal(readFileSync(path, "utf8"), stripped.text, "a real run writes exactly the stripped text");
    assert.deepEqual(evictReservedModuleEntries(repo, false), { evicted: [], changedFiles: [], details: [] }, "a second run has nothing left to do");
    const unreadableRepo = fresh("manifest-dir"); mkdirSync(join(unreadableRepo, "_bmad", "_config", "manifest.yaml"), { recursive: true });
    assert.deepEqual(evictReservedModuleEntries(unreadableRepo, false), { evicted: [], changedFiles: [], details: [] }, "an unreadable manifest is skipped, not thrown");
    console.log("PASS reserved-modules: only legacy reserved records are dropped, every other byte survives, dry run writes nothing");
  }
} finally {
  try { chmodSync(scratch, 0o700); } catch { /* gone */ }
  rmSync(scratch, { recursive: true, force: true });
}
console.log("PJAN-184 tree primitives: 8 checkpoint groups passed");
