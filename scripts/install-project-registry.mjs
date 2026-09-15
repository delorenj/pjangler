#!/usr/bin/env node
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { homedir, userInfo } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { execFileSync } from 'node:child_process';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const entrypoint = join(root, 'dist/project-registry-service.js');
if (!existsSync(entrypoint)) throw new Error('Build first: npm run build');
const directory = join(homedir(), '.config/systemd/user');
mkdirSync(directory, { recursive: true });
const unit = join(directory, 'pjangler-project-registry.service');
const quote = value => `"${value.replaceAll('\\', '\\\\').replaceAll('"', '\\"').replaceAll('%', '%%')}"`;
writeFileSync(unit, `[Unit]\nDescription=PJangler manifest-owned project registry\nAfter=network.target\n\n[Service]\nType=simple\nExecStart=${quote(process.execPath)} ${quote(entrypoint)}\nEnvironment=PGHOST=/var/run/postgresql\nEnvironment=PGDATABASE=33god\nEnvironment=PGUSER=${userInfo().username}\nEnvironment=PJ_REGISTRY_PORT=8764\nRestart=on-failure\nRestartSec=3\n\n[Install]\nWantedBy=default.target\n`);
const runtimeDir = process.env.XDG_RUNTIME_DIR || `/run/user/${userInfo().uid}`;
const systemdEnv = { ...process.env, ...(existsSync(runtimeDir) ? { XDG_RUNTIME_DIR: runtimeDir } : {}),
  ...(!process.env.DBUS_SESSION_BUS_ADDRESS && existsSync(join(runtimeDir, 'bus')) ? { DBUS_SESSION_BUS_ADDRESS: `unix:path=${join(runtimeDir, 'bus')}` } : {}) };
execFileSync('systemd-analyze', ['--user', 'verify', unit], { stdio: 'inherit', env: systemdEnv });
execFileSync('systemctl', ['--user', 'daemon-reload'], { stdio: 'inherit', env: systemdEnv });
execFileSync('systemctl', ['--user', 'enable', 'pjangler-project-registry.service'], { stdio: 'inherit', env: systemdEnv });
execFileSync('systemctl', ['--user', 'restart', 'pjangler-project-registry.service'], { stdio: 'inherit', env: systemdEnv });
let healthy = false;
for (let attempt = 0; attempt < 30; attempt++) {
  try {
    const response = await fetch('http://127.0.0.1:8764/health', { signal: AbortSignal.timeout(1000) });
    const health = await response.json();
    if (response.ok && health.ok && health.service === 'pjangler-project-registry') { healthy = true; break; }
  } catch {}
  await delay(200);
}
if (!healthy) throw new Error('Registry failed readiness check; inspect journalctl --user -u pjangler-project-registry.service');
console.log(`Installed and healthy: ${unit}`);
