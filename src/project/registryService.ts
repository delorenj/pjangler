import { createServer, type IncomingMessage } from 'node:http';
import { Pool } from 'pg';
import { readFile } from 'node:fs/promises';
import { ManifestIndex, RegistryError } from './manifestIndex';

const MAX_BODY = 8 * 1024 * 1024;
async function body(request: IncomingMessage): Promise<Record<string, any>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > MAX_BODY) throw new RegistryError('Request exceeds 8 MiB', 413, 'request_too_large');
    chunks.push(chunk);
  }
  let parsed;
  try { parsed = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw new RegistryError('Expected JSON request body', 400, 'invalid_request'); }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new RegistryError('Expected JSON object', 400, 'invalid_request');
  return parsed;
}

export async function createRegistryService(options: { pool?: Pool; port?: number; host?: string } = {}) {
  const pool = options.pool ?? new Pool({ database: process.env.PGDATABASE ?? '33god', connectionTimeoutMillis: 5000, statement_timeout: 15000 });
  const index = new ManifestIndex(pool);
  try { await index.initialize(); } catch (error) { if (!options.pool) await pool.end(); throw error; }
  const server = createServer(async (request, response) => {
    response.setHeader('content-type', 'application/json');
    response.setHeader('cache-control', 'no-store');
    try {
      const route = `${request.method} ${new URL(request.url ?? '/', 'http://localhost').pathname}`;
      let result;
      switch (route) {
        case 'GET /health':
          await pool.query('SELECT 1');
          result = { ok: true, service: 'pjangler-project-registry', schema_version: 1 };
          break;
        case 'GET /v1/registry': result = await index.load(); break;
        case 'POST /v1/reindex': result = await index.load(); break;
        case 'POST /v1/rebuild': {
          const payload = await body(request);
          let paths = payload.manifest_paths;
          if (payload.receipt_path !== undefined) {
            if (typeof payload.receipt_path !== 'string' || paths !== undefined) throw new RegistryError('Supply either manifest_paths or receipt_path', 400, 'invalid_request');
            const raw = await readFile(payload.receipt_path, 'utf8');
            if (Buffer.byteLength(raw) > MAX_BODY) throw new RegistryError('Discovery receipt exceeds 8 MiB', 413, 'request_too_large');
            let receipt;
            try { receipt = JSON.parse(raw); } catch { throw new RegistryError('Malformed discovery receipt', 422, 'invalid_request'); }
            if (!receipt || !Array.isArray(receipt.projects)) throw new RegistryError('Discovery receipt must contain projects array', 422, 'invalid_request');
            paths = receipt.projects.map((project: { manifest_path?: unknown } | null) => project?.manifest_path);
          }
          if (!Array.isArray(paths) || paths.length > 10000 || paths.some(path => typeof path !== 'string')) throw new RegistryError('manifest_paths must be an array of at most 10000 paths', 400, 'invalid_request');
          result = await index.rebuild(paths); break;
        }
        case 'POST /v1/index': {
          const payload = await body(request);
          if (typeof payload.manifest_path !== 'string') throw new RegistryError('manifest_path is required', 400, 'invalid_request');
          result = await index.index(payload.manifest_path); break;
        }
        case 'PUT /v1/registry': result = await index.save(await body(request)); break;
        case 'POST /v1/remove': result = await index.remove((await body(request)).project_id); break;
        case 'POST /v1/settings': result = await index.settings(await body(request)); break;
        default: throw new RegistryError('Unknown registry endpoint', 404, 'not_found');
      }
      response.end(JSON.stringify(result));
    } catch (error) {
      response.statusCode = error instanceof RegistryError ? error.status : 503;
      response.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error), code: error instanceof RegistryError ? error.code : 'registry_unavailable' }));
    }
  });
  server.requestTimeout = 30000;
  server.headersTimeout = 10000;
  server.keepAliveTimeout = 1000;
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.port ?? Number(process.env.PJ_REGISTRY_PORT ?? 8764), options.host ?? '127.0.0.1', () => { server.off('error', reject); resolve(); });
  }).catch(async error => { if (!options.pool) await pool.end(); throw error; });
  const address = server.address();
  return {
    server, pool, index, url: `http://127.0.0.1:${typeof address === 'object' ? address?.port : options.port}`,
    async close() {
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
      if (!options.pool) await pool.end();
    },
  };
}

export async function startRegistryService() {
  const service = await createRegistryService();
  console.log(`PJangler project registry listening at ${service.url}`);
  const stop = () => { void service.close().then(() => process.exit(0), error => { console.error(error); process.exit(1); }); };
  process.once('SIGTERM', stop);
  process.once('SIGINT', stop);
  return service;
}
