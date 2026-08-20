import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OpenNotebookClient } from "../src/notebook/open-notebook-client";
import { reconcileManagedNote, reconcileProjectNotebook } from "../src/notebook/reconcile";
import { commitReconciledRemoteMutation, listRemoteMutationJournals, mutationInputDigest, prepareRemoteMutation, transitionRemoteMutation } from "../src/notebook/remote-mutation-journal";
import { withNoteEnvelope } from "../src/notebook/notes";
import { DEFAULT_NOTEBOOK_LIMITS, NOTEBOOK_POLICY_VERSION, NotebookError, type EffectiveNotebookConfigV1 } from "../src/notebook/types";

function config(overrides: Partial<EffectiveNotebookConfigV1> = {}): EffectiveNotebookConfigV1 {
  return {
    schema_version: 1,
    project_slug: "alpha",
    repo_path: "/fixture/alpha",
    base_url: "http://127.0.0.1:8502",
    auth: { mode: "none" },
    policy: {
      enabled: true,
      session_start_enabled: true,
      session_capture_enabled: true,
      overview_max_chars: 4_000,
      documentation_globs: ["**/*.md"],
    },
    limits: { ...DEFAULT_NOTEBOOK_LIMITS, response_max_bytes: 1_024, overall_timeout_ms: 100 },
    binding: { state: "linked", notebook_id: "nb-1", overview_note_id: "overview-1", notebook_name: "Alpha" },
    configuration_provenance: {},
    ...overrides,
  };
}

function json(value: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json", ...headers } });
}

function assertCode(code: string): (error: unknown) => boolean {
  return (error) => error instanceof NotebookError && error.code === code;
}

const workspace = mkdtempSync(join(tmpdir(), "pjan-77-adapter-"));
try {
  const calls: Array<{ path: string; method: string; authorization?: string; body?: string }> = [];
  const notes = [{ id: "note-1", title: "Bound", content: "body", note_type: "human", created: null, updated: "2026-08-19T00:00:00Z" }];
  const fakeFetch: typeof fetch = async (request, init = {}) => {
    const url = new URL(String(request));
    const headers = new Headers(init.headers);
    calls.push({ path: `${url.pathname}${url.search}`, method: init.method ?? "GET", authorization: headers.get("authorization") ?? undefined, body: typeof init.body === "string" ? init.body : undefined });
    if (url.pathname === "/api/config") return json({ version: "1.14.0", auth_enabled: false });
    if (url.pathname === "/api/auth/status") return json({ auth_enabled: false, provider: null });
    if (url.pathname === "/api/notebooks") return json([{ id: "nb-1", name: "Alpha", description: "pjangler.project.v1:alpha", archived: false, created: "2026-08-18T00:00:00Z", updated: "2026-08-19T00:00:00Z" }]);
    if (url.pathname === "/api/notes" && init.method === "GET") {
      return json(notes.map((note) => ({ ...note, content: null })));
    }
    if (url.pathname === "/api/notes" && init.method === "POST") {
      const body = JSON.parse(String(init.body)) as { notebook_id: string; title: string; content: string; note_type: string };
      assert.equal(body.note_type, "human", "managed domain kinds are not sent as Open Notebook transport note types");
      return json({ id: "note-created", title: body.title, content: body.content, note_type: body.note_type, created: "2026-08-19T00:00:00Z", updated: "2026-08-19T00:00:01Z" }, 201);
    }
    if (url.pathname === "/api/notes/note-1" && init.method === "GET") return json(notes[0]);
    if (url.pathname === "/api/notes/note-1" && init.method === "PUT") return json({ ...notes[0], title: "Updated" });
    if (url.pathname === "/api/notes/note-1" && init.method === "DELETE") return new Response(null, { status: 204 });
    throw new Error(`unexpected fake request: ${init.method ?? "GET"} ${url}`);
  };
  const client = new OpenNotebookClient(config(), { fetch: fakeFetch });
  assert.equal((await client.health()).auth_enabled, false, "the separate auth-status response is the deployment authority");
  const listedNotebook = (await client.listNotebooks())[0]!;
  assert.equal(listedNotebook.id, "nb-1");
  assert.equal(listedNotebook.created_at, "2026-08-18T00:00:00Z", "v1.14 notebook `created` maps to the domain timestamp");
  assert.equal(listedNotebook.updated_at, "2026-08-19T00:00:00Z", "v1.14 notebook `updated` maps to the domain timestamp");
  const listedNote = (await client.listNotes("nb-1"))[0]!;
  assert.equal(listedNote.id, "note-1", "NoteResponse does not need notebook_id");
  assert.equal(listedNote.content, "body", "v1.14 null list content is hydrated only through the proven member detail endpoint");
  assert.equal(listedNote.updated_at, "2026-08-19T00:00:00Z", "v1.14 note `updated` maps to the domain timestamp");
  const createdNote = await client.createNote("nb-1", { title: "Created", content: "body" });
  assert.equal(createdNote.note_type, "human");
  assert.equal(createdNote.created_at, "2026-08-19T00:00:00Z");
  assert.equal((await client.getOwnedNote("nb-1", "note-1")).id, "note-1");
  assert.equal((await client.updateOwnedNote("nb-1", "note-1", { title: "Updated" })).title, "Updated");
  await client.deleteOwnedNote("nb-1", "note-1");
  assert.equal(Object.hasOwn(Object.getPrototypeOf(client), "updateNote"), false, "the adapter exposes no unscoped update port");
  assert.equal(Object.hasOwn(Object.getPrototypeOf(client), "deleteNote"), false, "the adapter exposes no unscoped delete port");
  assert.equal(calls.some((call) => call.path.startsWith("/api/search")), false, "public v1 never calls global search");

  let activeDetails = 0;
  let maxActiveDetails = 0;
  const fanoutMembers = Array.from({ length: 5 }, (_, index) => ({
    id: `fanout-${index}`,
    title: `Fanout ${index}`,
    content: null,
    note_type: "human",
    created: null,
    updated: "2026-08-19T00:00:00Z",
  }));
  const fanoutClient = new OpenNotebookClient(config({ limits: { ...DEFAULT_NOTEBOOK_LIMITS, response_max_bytes: 1_024, overall_timeout_ms: 500, note_detail_fetch_concurrency: 2 } }), { fetch: async (request) => {
    const url = new URL(String(request));
    if (url.pathname === "/api/notes") return json(fanoutMembers);
    activeDetails += 1;
    maxActiveDetails = Math.max(maxActiveDetails, activeDetails);
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 5));
    activeDetails -= 1;
    const id = decodeURIComponent(url.pathname.slice("/api/notes/".length));
    const member = fanoutMembers.find((item) => item.id === id)!;
    return json({ ...member, content: `body ${id}` });
  } });
  assert.equal((await fanoutClient.listNotes("nb-1")).length, fanoutMembers.length);
  assert.equal(maxActiveDetails, 2, "detail hydration obeys the configured finite fanout ceiling");

  const malformedDetail = new OpenNotebookClient(config(), { fetch: async (request) => {
    const url = new URL(String(request));
    if (url.pathname === "/api/notes") return json([{ id: "member-1", title: "Member", content: null, note_type: "human", created: null, updated: null }]);
    return json({ id: "different-id", title: "Member", content: "body", note_type: "human", created: null, updated: null });
  } });
  await assert.rejects(() => malformedDetail.listNotes("nb-1"), assertCode("REMOTE_PROTOCOL_ERROR"));

  const missingCanonicalContent = new OpenNotebookClient(config(), { fetch: async (request) => {
    const url = new URL(String(request));
    const note = { id: "member-1", title: "Member", content: null, note_type: "human", created: null, updated: null };
    return url.pathname === "/api/notes" ? json([note]) : json(note);
  } });
  await assert.rejects(() => missingCanonicalContent.listNotes("nb-1"), assertCode("REMOTE_PROTOCOL_ERROR"));

  let mutationCalls = 0;
  const missing = new OpenNotebookClient(config(), { fetch: async (request, init = {}) => {
    const url = new URL(String(request));
    if (url.pathname === "/api/config") return json({ version: "1.14.0" });
    if (url.pathname === "/api/notes" && init.method === "GET") return json([]);
    mutationCalls += 1;
    return json({});
  } });
  await assert.rejects(() => missing.updateOwnedNote("nb-1", "foreign", { title: "No" }), assertCode("NOT_FOUND"));
  assert.equal(mutationCalls, 0, "membership absence never probes or mutates an unscoped object");

  const authedCalls: Headers[] = [];
  const authed = new OpenNotebookClient(config({ auth: { mode: "environment", env_var: "OPEN_NOTEBOOK_PASSWORD" } }), {
    env: { OPEN_NOTEBOOK_PASSWORD: "runtime-only-token" },
    fetch: async (_request, init = {}) => {
      authedCalls.push(new Headers(init.headers));
      return authedCalls.length === 1 ? json({ auth_enabled: false }) : json([]);
    },
  });
  await authed.listNotebooks();
  assert.equal(authedCalls[0]?.get("authorization"), null, "auth-status probing never sends credentials");
  assert.equal(authedCalls[1]?.get("authorization"), null, "deployment auth-disabled status suppresses bearer credentials");

  const enabledHeaders: Headers[] = [];
  const enabledAuth = new OpenNotebookClient(config({ auth: { mode: "environment", env_var: "OPEN_NOTEBOOK_PASSWORD" } }), {
    env: { OPEN_NOTEBOOK_PASSWORD: "runtime-only-token" },
    fetch: async (_request, init = {}) => {
      enabledHeaders.push(new Headers(init.headers));
      return enabledHeaders.length === 1 ? json({ auth_enabled: true }) : json([]);
    },
  });
  await enabledAuth.listNotebooks();
  assert.equal(enabledHeaders[1]?.get("authorization"), "Bearer runtime-only-token", "enabled auth resolves the runtime credential only for the operation");

  for (const [status, code] of [[401, "AUTHENTICATION_FAILED"], [403, "AUTHENTICATION_FAILED"], [404, "NOT_FOUND"], [409, "CONFLICT"], [429, "THROTTLED"], [503, "SERVICE_UNAVAILABLE"]] as const) {
    const statusClient = new OpenNotebookClient(config(), { fetch: async (request) => new URL(String(request)).pathname === "/api/config" ? json({ version: "1.14.0" }) : new Response("bounded vendor failure", { status }) });
    await assert.rejects(() => statusClient.listNotebooks(), assertCode(code));
  }

  const redirect = new OpenNotebookClient(config(), { fetch: async () => new Response(null, { status: 302, headers: { location: "https://other.example.test/" } }) });
  await assert.rejects(() => redirect.listNotebooks(), assertCode("REMOTE_PROTOCOL_ERROR"));
  const malformed = new OpenNotebookClient(config(), { fetch: async (request) => new URL(String(request)).pathname === "/api/config" ? json({ version: "1.14.0" }) : new Response("{broken", { status: 200 }) });
  await assert.rejects(() => malformed.listNotebooks(), assertCode("REMOTE_PROTOCOL_ERROR"));
  const invalid = new OpenNotebookClient(config(), { fetch: async (request) => new URL(String(request)).pathname === "/api/config" ? json({ version: "1.14.0" }) : json([{ id: 7 }]) });
  await assert.rejects(() => invalid.listNotebooks(), assertCode("REMOTE_PROTOCOL_ERROR"));

  const oversized = new OpenNotebookClient(config({ limits: { ...DEFAULT_NOTEBOOK_LIMITS, response_max_bytes: 16, overall_timeout_ms: 100 } }), {
    fetch: async (request) => new URL(String(request)).pathname === "/api/config"
      ? json({ version: "1" })
      : new Response(new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(12)); controller.enqueue(new Uint8Array(12)); controller.close(); } })),
  });
  await assert.rejects(() => oversized.listNotebooks(), assertCode("REMOTE_PROTOCOL_ERROR"));

  const timeout = new OpenNotebookClient(config({ limits: { ...DEFAULT_NOTEBOOK_LIMITS, overall_timeout_ms: 10 } }), {
    fetch: async (_request, init = {}) => await new Promise<Response>((_resolve, reject) => init.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true })),
  });
  await assert.rejects(() => timeout.listNotebooks(), assertCode("TIMEOUT"));

  const notebooks: Array<{ id: string; name: string; description: string }> = [];
  let postCount = 0;
  let listAfterPost = false;
  const reconcileClient = new OpenNotebookClient(config(), { fetch: async (request, init = {}) => {
    const url = new URL(String(request));
    if (url.pathname === "/api/config") return json({ version: "1.14.0" });
    if (url.pathname === "/api/notebooks" && init.method === "GET") {
      if (postCount) listAfterPost = true;
      return json(notebooks);
    }
    if (url.pathname === "/api/notebooks" && init.method === "POST") {
      postCount += 1;
      const body = JSON.parse(String(init.body)) as { name: string; description: string };
      notebooks.push({ id: "created-1", ...body });
      return json(notebooks[0], 201);
    }
    if (url.pathname === "/api/notebooks/created-1" && init.method === "PUT") {
      const body = JSON.parse(String(init.body)) as { name: string; description: string; archived: boolean };
      notebooks[0] = { id: "created-1", name: body.name, description: body.description };
      return json({ ...notebooks[0], archived: body.archived });
    }
    throw new Error("unexpected reconciliation route");
  } });
  const reconciled = await reconcileProjectNotebook({ stateRoot: join(workspace, "state"), projectSlug: "alpha", name: "Alpha", client: reconcileClient });
  assert.equal(reconciled.notebook.id, "created-1");
  assert.equal(postCount, 1);
  assert.equal(listAfterPost, true, "create response alone never establishes identity");
  assert.equal(listRemoteMutationJournals(join(workspace, "state"), "alpha")[0]?.state, "reconciled", "remote identity remains reconciled until local binding ownership is durable");
  commitReconciledRemoteMutation(join(workspace, "state"), reconciled.journal);
  assert.equal(listRemoteMutationJournals(join(workspace, "state"), "alpha")[0]?.state, "committed");
  const again = await reconcileProjectNotebook({ stateRoot: join(workspace, "state"), projectSlug: "alpha", name: "Renamed display", client: reconcileClient });
  assert.equal(again.notebook.id, "created-1");
  assert.equal(again.notebook.name, "Renamed display", "display-name drift is repaired without changing the stable remote ID");
  assert.equal(postCount, 1, "stable marker wins across display-name drift");

  const changedState = join(workspace, "changed-input-state");
  let changedPosts = 0;
  let changedCandidates: Array<{ id: string; name: string; description: string; archived?: boolean }> = [];
  const changedInputClient = {
    async listNotebooks() { return changedCandidates.map((item) => ({ ...item })); },
    async createNotebook(_input: unknown, beforeDispatch?: () => void) {
      beforeDispatch?.();
      changedPosts += 1;
      throw new NotebookError("TIMEOUT", "ambiguous timeout", true);
    },
    async updateNotebook(id: string, input: { name: string; description: string; archived: boolean }) {
      const updated = { id, name: input.name, description: input.description, archived: input.archived };
      changedCandidates = [updated];
      return { ...updated };
    },
  };
  await assert.rejects(() => reconcileProjectNotebook({ stateRoot: changedState, projectSlug: "changed", name: "Original", client: changedInputClient as never }), assertCode("TIMEOUT"));
  await assert.rejects(() => reconcileProjectNotebook({ stateRoot: changedState, projectSlug: "changed", name: "Changed after timeout", client: changedInputClient as never }), assertCode("CONFLICT"));
  assert.equal(changedPosts, 1, "changed input after an unresolved dispatch and zero candidates never reserves or POSTs a second stable-marker operation");
  changedCandidates = [{ id: "changed-1", name: "Original", description: "pjangler.project.v1:changed", archived: false }];
  const recoveredChanged = await reconcileProjectNotebook({ stateRoot: changedState, projectSlug: "changed", name: "Changed after timeout", client: changedInputClient as never });
  assert.equal(recoveredChanged.notebook.name, "Changed after timeout");
  assert.equal(changedPosts, 1, "one marker candidate is adopted/repaired under the original reservation without a second POST");

  const recoveryLogicalId = "user-note:v1:11111111-1111-4111-8111-111111111111";
  const recoveryContent = withNoteEnvelope({
    schema_version: 1,
    project_slug: "recover",
    kind: "user-note",
    logical_id: recoveryLogicalId,
    policy_version: NOTEBOOK_POLICY_VERSION,
  }, "recovery body");
  const legacyState = join(workspace, "legacy-note-type-state");
  const legacyDigest = mutationInputDigest({ kind: "note.create", notebook_id: "nb-live", logical_id: recoveryLogicalId, title: "Project Overview", content: recoveryContent });
  let legacyJournal = prepareRemoteMutation({ root: legacyState, projectSlug: "recover", kind: "note.create", logicalMarker: recoveryLogicalId, inputDigest: legacyDigest, bindingId: "nb-live" });
  legacyJournal = transitionRemoteMutation({ root: legacyState, journal: legacyJournal, state: "possibly-dispatched", diagnostic: "possibly-dispatched" });
  const legacyEvents: string[] = [];
  const legacyNotes: Array<Record<string, unknown>> = [];
  let legacyNotebookPosts = 0;
  const legacyClient = new OpenNotebookClient(config({ project_slug: "recover", binding: { state: "linked", notebook_id: "nb-live", notebook_name: "Recover" } }), { fetch: async (request, init = {}) => {
    const url = new URL(String(request));
    if (url.pathname === "/api/notebooks" && init.method === "GET") return json([{ id: "nb-live", name: "Recover", description: "pjangler.project.v1:recover", archived: false, created: "2026-08-19T19:59:00Z", updated: "2026-08-19T19:59:00Z" }]);
    if (url.pathname === "/api/notebooks" && init.method === "POST") { legacyNotebookPosts += 1; throw new Error("must not duplicate the marker-owned notebook"); }
    if (url.pathname === "/api/notes" && init.method === "GET") { legacyEvents.push("list"); return json(legacyNotes); }
    if (url.pathname.startsWith("/api/notes/") && init.method === "GET") {
      legacyEvents.push("detail");
      const id = decodeURIComponent(url.pathname.slice("/api/notes/".length));
      return json(legacyNotes.find((note) => note.id === id));
    }
    if (url.pathname === "/api/notes" && init.method === "POST") {
      legacyEvents.push("post");
      const body = JSON.parse(String(init.body)) as { title: string; content: string; note_type: string };
      assert.equal(body.note_type, "human");
      const note = { id: "overview-live", title: body.title, content: body.content, note_type: body.note_type, created: "2026-08-19T20:00:00Z", updated: "2026-08-19T20:00:00Z" };
      legacyNotes.push(note);
      return json(note, 201);
    }
    throw new Error("unexpected legacy recovery request");
  } });
  const adoptedLiveNotebook = await reconcileProjectNotebook({ stateRoot: legacyState, projectSlug: "recover", name: "Recover", client: legacyClient });
  const adoptedLiveNotebookAgain = await reconcileProjectNotebook({ stateRoot: legacyState, projectSlug: "recover", name: "Recover", client: legacyClient });
  assert.equal(adoptedLiveNotebook.notebook.id, "nb-live");
  assert.equal(adoptedLiveNotebookAgain.journal.operation_id, adoptedLiveNotebook.journal.operation_id, "the reconciled-one notebook journal remains authoritative on retry");
  assert.equal(legacyNotebookPosts, 0, "stable-marker recovery never duplicates the existing notebook");
  const legacyRecovered = await reconcileManagedNote({ stateRoot: legacyState, projectSlug: "recover", notebookId: "nb-live", logicalId: recoveryLogicalId, title: "Project Overview", content: recoveryContent, client: legacyClient });
  assert.equal(legacyRecovered.note.id, "overview-live");
  assert.deepEqual(legacyEvents, ["list", "post", "list", "detail"], "the legacy v1.14 correction proves zero candidates before its single corrected POST, then hydrates the proven member");
  assert.equal(legacyRecovered.journal.operation_id, legacyJournal.operation_id, "legacy recovery reuses the authoritative journal");
  assert.equal(legacyRecovered.journal.input_digest, legacyDigest, "the durable operation identity remains stable across transport correction");
  assert.equal(legacyRecovered.journal.dispatch_digest, mutationInputDigest({ kind: "note.create", notebook_id: "nb-live", logical_id: recoveryLogicalId, title: "Project Overview", content: recoveryContent, note_type: "human" }));

  const ambiguousLegacyState = join(workspace, "ambiguous-legacy-note-state");
  let ambiguousLegacyJournal = prepareRemoteMutation({ root: ambiguousLegacyState, projectSlug: "recover", kind: "note.create", logicalMarker: recoveryLogicalId, inputDigest: "a".repeat(64), bindingId: "nb-live" });
  ambiguousLegacyJournal = transitionRemoteMutation({ root: ambiguousLegacyState, journal: ambiguousLegacyJournal, state: "possibly-dispatched", diagnostic: "possibly-dispatched" });
  let ambiguousLegacyPosts = 0;
  const ambiguousLegacyClient = {
    async listNotes() { return []; },
    async createNote() { ambiguousLegacyPosts += 1; throw new Error("must not dispatch"); },
  };
  await assert.rejects(() => reconcileManagedNote({ stateRoot: ambiguousLegacyState, projectSlug: "recover", notebookId: "nb-live", logicalId: recoveryLogicalId, title: "Project Overview", content: recoveryContent, client: ambiguousLegacyClient as never }), assertCode("CONFLICT"));
  assert.equal(ambiguousLegacyPosts, 0, "an old ambiguous journal whose operation digest does not match the exact corrected input remains blocked");

  const rejectedState = join(workspace, "definitive-400-state");
  const rejectedEvents: string[] = [];
  const rejectedNotes: Array<Record<string, unknown>> = [];
  let rejectedPosts = 0;
  const rejectedClient = new OpenNotebookClient(config({ project_slug: "recover", binding: { state: "linked", notebook_id: "nb-rejected", notebook_name: "Recover" } }), { fetch: async (request, init = {}) => {
    const url = new URL(String(request));
    if (url.pathname === "/api/notes" && init.method === "GET") { rejectedEvents.push("list"); return json(rejectedNotes); }
    if (url.pathname.startsWith("/api/notes/") && init.method === "GET") {
      rejectedEvents.push("detail");
      const id = decodeURIComponent(url.pathname.slice("/api/notes/".length));
      return json(rejectedNotes.find((note) => note.id === id));
    }
    if (url.pathname === "/api/notes" && init.method === "POST") {
      rejectedEvents.push("post");
      rejectedPosts += 1;
      if (rejectedPosts === 1) return json({ detail: "definitive validation rejection" }, 400);
      const body = JSON.parse(String(init.body)) as { title: string; content: string; note_type: string };
      const note = { id: "corrected-note", title: body.title, content: body.content, note_type: body.note_type, created: "2026-08-19T20:01:00Z", updated: "2026-08-19T20:01:00Z" };
      rejectedNotes.push(note);
      return json(note, 201);
    }
    throw new Error("unexpected definitive rejection request");
  } });
  await assert.rejects(() => reconcileManagedNote({ stateRoot: rejectedState, projectSlug: "recover", notebookId: "nb-rejected", logicalId: recoveryLogicalId, title: "Rejected title", content: recoveryContent, client: rejectedClient }), assertCode("INVALID_INPUT"));
  const rejectedJournal = listRemoteMutationJournals(rejectedState, "recover")[0]!;
  assert.equal(rejectedJournal.state, "possibly-dispatched");
  assert.equal(rejectedJournal.definitive_http_status, 400, "the exact rejected dispatch is durably distinguishable from an ambiguous timeout");
  await assert.rejects(() => reconcileManagedNote({ stateRoot: rejectedState, projectSlug: "recover", notebookId: "nb-rejected", logicalId: recoveryLogicalId, title: "Rejected title", content: recoveryContent, client: rejectedClient }), assertCode("CONFLICT"));
  assert.equal(rejectedPosts, 1, "the same definitively rejected input is not automatically looped");
  const corrected = await reconcileManagedNote({ stateRoot: rejectedState, projectSlug: "recover", notebookId: "nb-rejected", logicalId: recoveryLogicalId, title: "Corrected title", content: recoveryContent, client: rejectedClient });
  assert.equal(corrected.note.id, "corrected-note");
  assert.equal(corrected.journal.operation_id, rejectedJournal.operation_id, "corrected input reuses the authoritative rejected journal");
  assert.deepEqual(rejectedEvents, ["list", "post", "list", "list", "post", "list", "detail"], "every dispatch attempt is preceded by a fresh zero-candidate reconciliation and success hydrates the proven member");

  const persistedState = join(workspace, "persisted-null-summary-state");
  const persistedLogicalId = "overview:v1:recover";
  const persistedContent = withNoteEnvelope({
    schema_version: 1,
    project_slug: "recover",
    kind: "overview",
    logical_id: persistedLogicalId,
    overview_descriptor: {
      schema_version: 1,
      project_slug: "recover",
      project_name: "Recover",
      purpose: "Recovered project",
      references: [],
      compiler_policy_version: NOTEBOOK_POLICY_VERSION,
    },
    policy_version: NOTEBOOK_POLICY_VERSION,
  }, "persisted overview");
  const persistedDigest = mutationInputDigest({ kind: "note.create", notebook_id: "nb-live", logical_id: persistedLogicalId, title: "Project Overview", content: persistedContent });
  const persistedDispatchDigest = mutationInputDigest({ kind: "note.create", notebook_id: "nb-live", logical_id: persistedLogicalId, title: "Project Overview", content: persistedContent, note_type: "human" });
  let persistedJournal = prepareRemoteMutation({ root: persistedState, projectSlug: "recover", kind: "note.create", logicalMarker: persistedLogicalId, inputDigest: persistedDigest, dispatchDigest: persistedDispatchDigest, bindingId: "nb-live" });
  persistedJournal = transitionRemoteMutation({ root: persistedState, journal: persistedJournal, state: "possibly-dispatched", diagnostic: "possibly-dispatched" });
  const persistedEvents: string[] = [];
  let persistedPosts = 0;
  const persistedClient = new OpenNotebookClient(config({ project_slug: "recover", binding: { state: "linked", notebook_id: "nb-live", notebook_name: "Recover" } }), { fetch: async (request, init = {}) => {
    const url = new URL(String(request));
    if (url.pathname === "/api/notes" && init.method === "GET") {
      persistedEvents.push("scoped-list");
      return json([{ id: "note:live-overview", title: "Project Overview", content: null, note_type: "human", created: "2026-08-19T20:02:00.000Z", updated: "2026-08-19T20:02:00.000Z", command_id: null }]);
    }
    if (decodeURIComponent(url.pathname) === "/api/notes/note:live-overview" && init.method === "GET") {
      persistedEvents.push("member-detail");
      return json({ id: "note:live-overview", title: "Project Overview", content: persistedContent, note_type: "human", created: "2026-08-19T20:02:00.000Z", updated: "2026-08-19T20:02:00.000Z", command_id: null });
    }
    if (url.pathname === "/api/notes" && init.method === "POST") {
      persistedPosts += 1;
      throw new Error("an already-persisted marker note must never be posted again");
    }
    throw new Error(`unexpected persisted recovery request: ${init.method ?? "GET"} ${url.pathname}`);
  } });
  const persistedRecovered = await reconcileManagedNote({ stateRoot: persistedState, projectSlug: "recover", notebookId: "nb-live", logicalId: persistedLogicalId, title: "Project Overview", content: persistedContent, client: persistedClient });
  assert.equal(persistedRecovered.note.id, "note:live-overview");
  assert.equal(persistedRecovered.adopted, true);
  assert.equal(persistedRecovered.journal.operation_id, persistedJournal.operation_id, "the persisted note completes the authoritative journal instead of reserving another operation");
  assert.equal(persistedRecovered.journal.state, "reconciled");
  assert.equal(persistedPosts, 0, "membership plus full-envelope hydration adopts the existing note with zero POSTs");
  assert.deepEqual(persistedEvents, ["scoped-list", "member-detail"], "detail hydration occurs only after notebook-scoped membership proof");

  notebooks.push({ id: "duplicate-marker", name: "Same name allowed", description: "pjangler.project.v1:alpha" });
  await assert.rejects(() => reconcileProjectNotebook({ stateRoot: join(workspace, "other-state"), projectSlug: "alpha", name: "Alpha", client: reconcileClient }), assertCode("CONFLICT"));
  assert.equal(postCount, 1, "multiple exact markers never trigger a destructive or arbitrary choice");

  console.log("pjan-77 notebook adapter contract: ok");
} finally {
  rmSync(workspace, { recursive: true, force: true });
}
