// Run a command on a REAL pseudo-terminal and drive it with keystrokes (PJAN-184).
//
// spawnSync pipes give a child no TTY, so `isInteractive()` is false and the Ink screens
// are unreachable. Node has no pty in its standard library, but python3 does (`pty.fork`),
// and every machine that runs this suite already needs python3 for the zcrank engine
// probe. The child sees a genuine terminal on stdin AND stdout; this helper only writes
// keys and reads what the terminal would have shown.
//
// steps: [{ wait: RegExp source, send: "keys" }, ...]. Each step waits (against the ANSI-
// stripped output so far) for `wait`, then writes `send`. After the last step the child
// is given `settleMs` to exit on its own, then killed. Resolves { status, output, timedOut }.

import { spawnSync } from "node:child_process";

const DRIVER = `
import fcntl, json, os, re, select, signal, struct, sys, termios, time
spec = json.loads(sys.argv[1])
pid, fd = __import__("pty").fork()
if pid == 0:
    os.chdir(spec["cwd"])
    os.execvpe(spec["argv"][0], spec["argv"], spec["env"])
fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", 40, 110, 0, 0))
ansi = re.compile(r"\\x1b\\[[0-9;?]*[A-Za-z]")
buf = b""
deadline = time.time() + spec["timeout"]
status = None
def pump(t):
    global buf
    r, _, _ = select.select([fd], [], [], t)
    if r:
        try:
            data = os.read(fd, 65536)
        except OSError:
            return False
        if not data:
            return False
        buf += data
    return True
def text():
    return ansi.sub("", buf.decode("utf8", "replace"))
alive = True
timed_out = False
for step in spec["steps"]:
    pat = re.compile(step["wait"])
    while alive and not pat.search(text()):
        if time.time() > deadline:
            timed_out = True
            break
        alive = pump(0.1)
    if timed_out or not alive:
        break
    if step.get("send"):
        time.sleep(0.05)
        os.write(fd, step["send"].encode())
settle = time.time() + spec["settle"]
while alive and time.time() < settle:
    alive = pump(0.1)
try:
    done, st = os.waitpid(pid, os.WNOHANG)
    if done == 0:
        os.kill(pid, signal.SIGKILL)
        _, st = os.waitpid(pid, 0)
        timed_out = True
    status = os.waitstatus_to_exitcode(st)
except ChildProcessError:
    status = -1
while True:
    try:
        if not pump(0.05):
            break
    except Exception:
        break
print(json.dumps({"status": status, "output": text(), "timedOut": timed_out}))
`;

export function runOnPty({ argv, cwd, env, steps, timeoutMs = 20_000, settleMs = 5_000 }) {
  const spec = JSON.stringify({ argv, cwd, env, steps, timeout: timeoutMs / 1000, settle: settleMs / 1000 });
  const result = spawnSync("python3", ["-I", "-c", DRIVER, spec], { encoding: "utf8", timeout: timeoutMs + settleMs + 10_000 });
  if (result.status !== 0) throw new Error(`pty driver failed (${result.status}): ${result.stderr}`);
  return JSON.parse(result.stdout);
}
