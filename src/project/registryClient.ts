import { spawnSync } from "node:child_process";
import { currentOperation, runChild, assertOperationActive } from "../lifecycle/operation.ts";
import { AsyncLocalStorage } from "node:async_hooks";

// Synchronous configuration readers consume one request-local snapshot. MCP
// primes it asynchronously before entering legacy filesystem-only readers.
const snapshots = new AsyncLocalStorage<Map<string, unknown>>();
export const withRegistrySnapshots = <T>(work: () => Promise<T>): Promise<T> => snapshots.run(new Map(), work);
export async function primeRegistrySnapshot(location: string): Promise<void> {
  const endpoint = resolveRegistryLocation(location);
  if (!isRegistryServiceLocation(endpoint) || snapshots.getStore()?.has(endpoint)) return;
  const registry = await registryRequestAsync(endpoint, "GET", "/v1/registry");
  assertOperationActive();
  snapshots.getStore()?.set(endpoint, registry);
}
export async function registryRequestAsync<T>(location: string, method: string, path: string, body?: unknown): Promise<T> {
  const endpoint = resolveRegistryLocation(location);
  const result = await runChild(process.execPath, ["--input-type=module", "-e", REQUEST], {
    input: JSON.stringify({ url: `${endpoint}${path}`, method, body, timeout: 15_000 }), timeoutMs: 17_000,
  });
  assertOperationActive();
  if (result.error || result.status !== 0) throw new Error(`Project registry request failed (${endpoint}): ${result.stderr.trim() || result.error?.message || "request failed"}`);
  try { return JSON.parse(result.stdout) as T; }
  catch { throw new Error(`Project registry returned invalid JSON (${endpoint})`); }
}
import { homedir } from "node:os";
import { resolve } from "node:path";

export const DEFAULT_REGISTRY_URL = "http://localhost:8764";

export function isRegistryServiceLocation(location: string): boolean {
  return /^https?:\/\//i.test(location);
}

/** An explicit file location is an import/test adapter; production uses the service. */
export function resolveRegistryLocation(location?: string, env: NodeJS.ProcessEnv = process.env): string {
  const value = location || env.PJ_PROJECT_REGISTRY || env.PJ_REGISTRY_URL || DEFAULT_REGISTRY_URL;
  if (isRegistryServiceLocation(value)) {
    const url = new URL(value);
    if (url.username || url.password || url.search || url.hash) throw new Error("Registry URL must not contain credentials, a query or a fragment");
    return url.toString().replace(/\/$/, "");
  }
  return resolve(value.startsWith("~/") ? `${homedir()}/${value.slice(2)}` : value);
}

// Existing lifecycle/config APIs are synchronous. Isolate the network wait in
// a bounded Node child rather than making a file cache a second authority.
// Request bodies travel over stdin, never through shell interpolation/argv.
const REQUEST = `
let input='';
for await (const chunk of process.stdin) input+=chunk;
const {url,method,body,timeout}=JSON.parse(input);
try {
  const response=await fetch(url,{method,headers:{'Content-Type':'application/json'},
    ...(body===undefined?{}:{body:JSON.stringify(body)}),signal:AbortSignal.timeout(timeout)});
  const text=await response.text();
  let result;try{result=JSON.parse(text)}catch{throw new Error('Registry returned invalid JSON')}
  if(!response.ok) throw new Error(result.error||result.message||('Registry HTTP '+response.status));
  process.stdout.write(JSON.stringify(result));
} catch(error) {process.stderr.write(error.message);process.exitCode=1;}
`;

export function registryRequest<T>(location: string, method: string, path: string, body?: unknown): T {
  const endpoint = resolveRegistryLocation(location);
  assertOperationActive();
  if (currentOperation()) {
    const cached = snapshots.getStore()?.get(endpoint);
    if (method === "GET" && path === "/v1/registry" && cached !== undefined) return structuredClone(cached) as T;
    throw new Error(`MCP registry call requires async request: ${method} ${path}`);
  }
  if (!isRegistryServiceLocation(endpoint)) throw new Error("This operation requires the project registry service");
  const timeout = 15_000;
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", REQUEST], {
    input: JSON.stringify({ url: `${endpoint}${path}`, method, body, timeout }),
    encoding: "utf8", timeout: timeout + 2_000, maxBuffer: 16 * 1024 * 1024,
  });
  if (result.status !== 0 || result.error) {
    const detail = result.stderr?.trim() || result.error?.message || "request failed";
    throw new Error(`Project registry request failed (${endpoint}): ${detail}. Check pjangler-project-registry.service; local pj info remains available.`);
  }
  try { return JSON.parse(result.stdout) as T; }
  catch { throw new Error(`Project registry returned invalid JSON (${endpoint})`); }
}

export function normalizeProjectId(value: unknown): string {
  if (typeof value !== "string") throw new Error("project_id is required");
  const id = value.trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9-]*$/.test(id) || id.endsWith("-") || id.length > 128) {
    throw new Error(`Invalid project_id: ${value}; use letters, digits and internal hyphens`);
  }
  return id;
}
