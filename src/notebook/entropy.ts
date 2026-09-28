import { existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { parseNoteEnvelope, withNoteEnvelope } from "./notes";
import { looksGenerated, matchesSimpleGlob, readSafeEvidenceText, type EligibleDocumentV1 } from "./git-evidence";
import type { NotebookModule } from "./module";
import type { OpenNotebookClient } from "./open-notebook-client";
import {
  NOTEBOOK_POLICY_VERSION,
  NOTEBOOK_SCHEMA_VERSION,
  type EffectiveNotebookConfigV1,
  type OpenNotebookNoteV1,
  type PjanglerNoteEnvelopeV1,
} from "./types";

export interface EntropyReconciliationResultV1 {
  overviewReconciled: boolean;
  zombieNotesPruned: string[];
  sessionCapturesCompacted: number;
  sourcesCreated: string[];
  sourcesPruned: string[];
}

export function listAllTrackedDocuments(config: EffectiveNotebookConfigV1): EligibleDocumentV1[] {
  const repo = config.repo_path;
  const timeout = config.limits.overall_timeout_ms;
  const trackedResult = spawnSync("git", ["ls-files", "-z"], { cwd: repo, encoding: "utf8", maxBuffer: 4 * 1024 * 1024, timeout, shell: false });
  if (trackedResult.status !== 0) return [];
  const tracked = trackedResult.stdout.split("\0").filter(Boolean);
  const headRev = spawnSync("git", ["rev-parse", "HEAD"], { cwd: repo, encoding: "utf8", timeout, shell: false }).stdout?.trim() ?? "HEAD";
  const documents: EligibleDocumentV1[] = [];

  for (const path of tracked) {
    if (!config.policy.documentation_globs.some((glob) => matchesSimpleGlob(path, glob))) continue;
    if (config.policy.excluded_globs?.some((glob) => matchesSimpleGlob(path, glob))) continue;
    if (looksGenerated(path)) continue;
    const file = readSafeEvidenceText(repo, path, config.limits.source_file_max_bytes);
    if (file.status !== "present") continue;
    documents.push({
      path,
      source_revision: headRev,
      content_sha256: file.content_sha256,
      content: file.content,
    });
  }
  return documents;
}

export async function pruneZombieNotes(input: {
  client: OpenNotebookClient;
  notebookId: string;
  projectSlug: string;
  repoPath: string;
}): Promise<string[]> {
  const headers = typeof input.client.listNoteHeaders === "function"
    ? await input.client.listNoteHeaders(input.notebookId)
    : await input.client.listNotes(input.notebookId);
  const documentCandidates = headers.filter((h) => !h.title.startsWith("Session Capture") && h.title !== "Project Overview");
  if (!documentCandidates.length) return [];
  const notes = typeof input.client.hydrateNotes === "function"
    ? await input.client.hydrateNotes(documentCandidates)
    : documentCandidates as unknown as OpenNotebookNoteV1[];
  const pruned: string[] = [];

  for (const note of notes) {
    const parsed = parseNoteEnvelope(note.content);
    if (!parsed || parsed.envelope.kind !== "document" || parsed.envelope.project_slug !== input.projectSlug) continue;
    const sourcePath = parsed.envelope.source_path;
    if (!sourcePath || !existsSync(resolve(input.repoPath, sourcePath))) {
      if (typeof input.client.deleteOwnedNote === "function") {
        await input.client.deleteOwnedNote(input.notebookId, note.id);
      } else if (typeof (input.client as any).deleteNote === "function") {
        await (input.client as any).deleteNote(note.id);
      }
      pruned.push(note.title);
    }
  }
  return pruned;
}

export async function compactSessionCaptures(input: {
  client: OpenNotebookClient;
  notebookId: string;
  projectSlug: string;
  maxRecent?: number;
}): Promise<number> {
  const maxRecent = input.maxRecent ?? 10;
  const headers = typeof input.client.listNoteHeaders === "function"
    ? await input.client.listNoteHeaders(input.notebookId)
    : await input.client.listNotes(input.notebookId);
  const sessionHeaders = headers
    .filter((h) => h.title.startsWith("Session Capture ") && !h.title.includes("Archive"))
    .sort((a, b) => (b.updated_at ?? "").localeCompare(a.updated_at ?? ""));

  if (sessionHeaders.length <= maxRecent) return 0;
  const toCompact = sessionHeaders.slice(maxRecent);
  const notesToCompact = typeof input.client.hydrateNotes === "function"
    ? await input.client.hydrateNotes(toCompact)
    : toCompact as unknown as OpenNotebookNoteV1[];

  const archiveTitle = "Session Captures Archive (Prior Sessions)";
  const slugHash = createHash("sha256").update(`session-capture-archive:${input.projectSlug}`).digest("hex").slice(0, 32);
  const archiveLogicalId = `user-note:v1:${slugHash}`;
  let existingArchiveContent = "";
  let existingArchiveId: string | null = null;

  for (const h of headers) {
    if (h.title === archiveTitle) {
      existingArchiveId = h.id;
      const note = typeof input.client.getOwnedNote === "function"
        ? await input.client.getOwnedNote(input.notebookId, h.id)
        : (headers as unknown as OpenNotebookNoteV1[]).find((x) => x.id === h.id);
      const parsed = note ? parseNoteEnvelope(note.content) : null;
      existingArchiveContent = parsed?.body ?? note?.content ?? "";
      break;
    }
  }

  const newArchiveSections: string[] = [];
  if (!existingArchiveContent) {
    newArchiveSections.push("# Session Captures Archive\n\nChronological archive of compacted past agent sessions for this project.\n");
  } else {
    newArchiveSections.push(existingArchiveContent.trim());
  }

  for (const note of notesToCompact) {
    const parsed = parseNoteEnvelope(note.content);
    const body = parsed?.body ?? note.content;
    newArchiveSections.push(`\n\n---\n\n### ${note.title}\n\n${body.trim()}`);
  }

  const archiveEnvelope: PjanglerNoteEnvelopeV1 = {
    schema_version: NOTEBOOK_SCHEMA_VERSION,
    project_slug: input.projectSlug,
    kind: "user-note",
    logical_id: archiveLogicalId,
    policy_version: NOTEBOOK_POLICY_VERSION,
  };
  const finalContent = withNoteEnvelope(archiveEnvelope, newArchiveSections.join("\n"));

  if (existingArchiveId) {
    if (typeof input.client.updateOwnedNote === "function") {
      await input.client.updateOwnedNote(input.notebookId, existingArchiveId, { content: finalContent });
    } else if (typeof (input.client as any).updateNote === "function") {
      await (input.client as any).updateNote(existingArchiveId, { content: finalContent });
    }
  } else {
    await input.client.createNote(input.notebookId, {
      title: archiveTitle,
      content: finalContent,
      note_type: "human",
    });
  }

  for (const note of notesToCompact) {
    if (typeof input.client.deleteOwnedNote === "function") {
      await input.client.deleteOwnedNote(input.notebookId, note.id);
    } else if (typeof (input.client as any).deleteNote === "function") {
      await (input.client as any).deleteNote(note.id);
    }
  }

  return notesToCompact.length;
}

export async function syncSources(input: {
  client: OpenNotebookClient;
  notebookId: string;
  config: EffectiveNotebookConfigV1;
}): Promise<{ created: string[]; pruned: string[] }> {
  if (typeof input.client.listSources !== "function") {
    return { created: [], pruned: [] };
  }
  const tracked = listAllTrackedDocuments(input.config);
  const existingSources = await input.client.listSources(input.notebookId);
  const byTitle = new Map(existingSources.map((s) => [s.title, s]));
  const created: string[] = [];
  const pruned: string[] = [];
  const trackedTitles = new Set<string>();

  for (const doc of tracked) {
    trackedTitles.add(doc.path);
    const existing = byTitle.get(doc.path);
    if (!existing) {
      await input.client.createSource({
        notebookId: input.notebookId,
        title: doc.path,
        content: doc.content,
        embed: false,
      });
      created.push(doc.path);
    }
  }

  for (const source of existingSources) {
    if ((source.title.endsWith(".md") || source.title.endsWith(".mdx")) && !trackedTitles.has(source.title)) {
      await input.client.deleteSource(source.id);
      pruned.push(source.title);
    }
  }

  return { created, pruned };
}

export async function reconcileNotebookEntropy(input: {
  module: NotebookModule;
  projectSlug: string;
  repoPath: string;
  client: OpenNotebookClient;
  notebookId: string;
  config: EffectiveNotebookConfigV1;
  syncSourcesFlag?: boolean;
}): Promise<EntropyReconciliationResultV1> {
  let overviewReconciled = false;
  try {
    const overviewResult = await input.module.overview(input.repoPath);
    if (overviewResult.data.drift.length > 0) {
      await input.module.reconcileOverview(input.repoPath);
      overviewReconciled = true;
    }
  } catch {
    // If overview is not yet created or unlinked, skip overview healing
  }

  const zombieNotesPruned = await pruneZombieNotes({
    client: input.client,
    notebookId: input.notebookId,
    projectSlug: input.projectSlug,
    repoPath: input.repoPath,
  });

  const sessionCapturesCompacted = await compactSessionCaptures({
    client: input.client,
    notebookId: input.notebookId,
    projectSlug: input.projectSlug,
  });

  let sourcesCreated: string[] = [];
  let sourcesPruned: string[] = [];
  if (input.syncSourcesFlag) {
    const sourcesResult = await syncSources({
      client: input.client,
      notebookId: input.notebookId,
      config: input.config,
    });
    sourcesCreated = sourcesResult.created;
    sourcesPruned = sourcesResult.pruned;
  }

  return {
    overviewReconciled,
    zombieNotesPruned,
    sessionCapturesCompacted,
    sourcesCreated,
    sourcesPruned,
  };
}
