import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OpenNotebookClient } from "../src/notebook/open-notebook-client";
import { reconcileProjectNotebook } from "../src/notebook/reconcile";
import { commitReconciledRemoteMutation, listRemoteMutationJournals } from "../src/notebook/remote-mutation-journal";
import { DEFAULT_NOTEBOOK_LIMITS, NotebookError, type EffectiveNotebookConfigV1 } from "../src/notebook/types";

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
  const notes = [{ id: "note-1", title: "Bound", content: "body", note_type: "note", created_at: null, updated_at: "2026-08-19T00:00:00Z" }];
  const fakeFetch: typeof fetch = async (request, init = {}) => {
    const url = new URL(String(request));
    const headers = new Headers(init.headers);
    calls.push({ path: `${url.pathname}${url.search}`, method: init.method ?? "GET", authorization: headers.get("authorization") ?? undefined, body: typeof init.body === "string" ? init.body : undefined });
    if (url.pathname === "/api/config") return json({ version: "1.14.0", auth_enabled: false });
    if (url.pathname === "/api/auth/status") return json({ auth_enabled: false, provider: null });
    if (url.pathname === "/api/notebooks") return json([{ id: "nb-1", name: "Alpha", description: "pjangler.project.v1:alpha", archived: false }]);
    if (url.pathname === "/api/notes" && init.method === "GET") return json(notes);
    if (url.pathname === "/api/notes/note-1" && init.method === "PUT") return json({ ...notes[0], title: "Updated" });
    if (url.pathname === "/api/notes/note-1" && init.method === "DELETE") return new Response(null, { status: 204 });
    throw new Error(`unexpected fake request: ${init.method ?? "GET"} ${url}`);
  };
  const client = new OpenNotebookClient(config(), { fetch: fakeFetch });
  assert.equal((await client.health()).auth_enabled, false, "the separate auth-status response is the deployment authority");
  assert.equal((await client.listNotebooks())[0]?.id, "nb-1");
  assert.equal((await client.listNotes("nb-1"))[0]?.id, "note-1", "NoteResponse does not need notebook_id");
  assert.equal((await client.getOwnedNote("nb-1", "note-1")).id, "note-1");
  assert.equal((await client.updateOwnedNote("nb-1", "note-1", { title: "Updated" })).title, "Updated");
  await client.deleteOwnedNote("nb-1", "note-1");
  assert.equal(Object.hasOwn(Object.getPrototypeOf(client), "updateNote"), false, "the adapter exposes no unscoped update port");
  assert.equal(Object.hasOwn(Object.getPrototypeOf(client), "deleteNote"), false, "the adapter exposes no unscoped delete port");
  assert.equal(calls.some((call) => call.path.startsWith("/api/search")), false, "public v1 never calls global search");

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

  notebooks.push({ id: "duplicate-marker", name: "Same name allowed", description: "pjangler.project.v1:alpha" });
  await assert.rejects(() => reconcileProjectNotebook({ stateRoot: join(workspace, "other-state"), projectSlug: "alpha", name: "Alpha", client: reconcileClient }), assertCode("CONFLICT"));
  assert.equal(postCount, 1, "multiple exact markers never trigger a destructive or arbitrary choice");

  console.log("pjan-77 notebook adapter contract: ok");
} finally {
  rmSync(workspace, { recursive: true, force: true });
}
