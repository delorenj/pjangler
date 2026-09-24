import { timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { journalNoteOperationId, type JournalPeriod } from "./journal-key";
import { NotebookModule } from "./module";
import { normalizeNotebookError } from "./output";
import { NotebookError } from "./types";

const MAX_REQUEST_BYTES = 1_048_576;
const ROUTE = /^\/v1\/projects\/infra\/notes\/(daily|weekly|monthly)\/([^/]+)$/u;

type JournalWriter = Pick<NotebookModule, "upsertInfraJournalNote">;

function writeJson(response: ServerResponse, status: number, body: unknown): void {
  response.statusCode = status;
  response.setHeader("content-type", "application/json; charset=utf-8");
  response.setHeader("cache-control", "no-store");
  response.end(JSON.stringify(body));
}

function authorized(request: IncomingMessage, token: string | undefined): boolean {
  if (!token) return true;
  const supplied = request.headers.authorization;
  if (typeof supplied !== "string" || !supplied.startsWith("Bearer ")) return false;
  const actual = Buffer.from(supplied.slice(7), "utf8");
  const expected = Buffer.from(token, "utf8");
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

async function readBody(request: IncomingMessage): Promise<{ title: string; content: string }> {
  if (!/^application\/json(?:\s*;|$)/iu.test(request.headers["content-type"] ?? "")) {
    throw new NotebookError("INVALID_INPUT", "Request content type must be application/json");
  }
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of request) {
    const part = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += part.byteLength;
    if (bytes > MAX_REQUEST_BYTES) throw new NotebookError("INVALID_INPUT", "Request exceeds 1 MiB");
    chunks.push(part);
  }
  let parsed: unknown;
  try { parsed = JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown; }
  catch { throw new NotebookError("INVALID_INPUT", "Request body must be valid JSON"); }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new NotebookError("INVALID_INPUT", "Request body must be an object");
  const body = parsed as Record<string, unknown>;
  if (Object.keys(body).some((key) => key !== "title" && key !== "content")
    || typeof body.title !== "string" || typeof body.content !== "string") {
    throw new NotebookError("INVALID_INPUT", "Request body must contain only string title and content fields");
  }
  return { title: body.title, content: body.content };
}

function errorStatus(code: NotebookError["code"]): number {
  switch (code) {
    case "INVALID_INPUT": return 400;
    case "AUTHENTICATION_FAILED": return 401;
    case "CROSS_PROJECT": return 403;
    case "NOT_FOUND": return 404;
    case "CONFLICT":
    case "DRIFT_DETECTED": return 409;
    case "THROTTLED": return 429;
    case "TIMEOUT": return 504;
    default: return 503;
  }
}

/** A loopback-only ingress for n8n; all remote note access remains in NotebookModule. */
export async function createJournalNotebookService(options: {
  module?: JournalWriter;
  port?: number;
  token?: string;
} = {}) {
  const module = options.module ?? new NotebookModule();
  const token = options.token ?? process.env.PJ_JOURNAL_NOTEBOOK_API_TOKEN;
  const server = createServer(async (request, response) => {
    try {
      const pathname = new URL(request.url ?? "/", "http://localhost").pathname;
      if (request.method === "GET" && pathname === "/health") {
        writeJson(response, 200, { ok: true, service: "pjangler-journal-notebook", schema_version: 1 });
        return;
      }
      const match = request.method === "PUT" ? ROUTE.exec(pathname) : null;
      if (!match) { writeJson(response, 404, { error: "Unknown journal notebook endpoint", code: "NOT_FOUND" }); return; }
      if (!authorized(request, token)) { writeJson(response, 401, { error: "Unauthorized", code: "AUTHENTICATION_FAILED" }); return; }
      const period = match[1] as JournalPeriod;
      const periodKey = match[2]!;
      journalNoteOperationId(period, periodKey);
      const { title, content } = await readBody(request);
      const result = await module.upsertInfraJournalNote(period, periodKey, title, content);
      writeJson(response, result.created ? 201 : 200, { ok: true, period, period_key: periodKey, ...result });
    } catch (error) {
      const normalized = normalizeNotebookError(error);
      writeJson(response, errorStatus(normalized.code), { error: normalized.message, code: normalized.code, retryable: normalized.retryable });
    }
  });
  server.requestTimeout = 30_000;
  server.headersTimeout = 10_000;
  server.keepAliveTimeout = 1_000;
  await new Promise<void>((done, reject) => {
    server.once("error", reject);
    server.listen(options.port ?? Number(process.env.PJ_JOURNAL_NOTEBOOK_PORT ?? 8765), "127.0.0.1", () => {
      server.off("error", reject);
      done();
    });
  });
  const address = server.address();
  return {
    server,
    url: `http://127.0.0.1:${typeof address === "object" ? address?.port : options.port}`,
    close: () => new Promise<void>((done, reject) => server.close((error) => error ? reject(error) : done())),
  };
}

export async function startJournalNotebookService(): Promise<void> {
  const service = await createJournalNotebookService();
  console.log(`PJangler journal notebook listening at ${service.url}`);
  const stop = () => { void service.close().then(() => process.exit(0), (error) => { console.error(error); process.exit(1); }); };
  process.once("SIGTERM", stop);
  process.once("SIGINT", stop);
}
