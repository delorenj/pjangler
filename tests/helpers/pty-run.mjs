// Run a command on a REAL pseudo-terminal and drive it with keystrokes (PJAN-184).
//
// spawnSync pipes give a child no TTY, so `isInteractive()` is false and the Ink screens
// are unreachable. Node has no pty in its standard library, but python3 does (`pty.fork`),
// and every machine that runs this suite already needs python3 for the zcrank engine
// probe. The child sees a genuine terminal on stdin AND stdout; this helper only writes
// keys and reads what the terminal would have shown.
//
// steps: [{ wait: RegExp source, send: "keys", ready?: false }, ...]. Each step waits (against
// the ANSI-stripped output so far) for `wait`, then writes `send`. After the last step the
// child is given `settleMs` to EXIT ON ITS OWN, then killed. Resolves
//   { status, output, timedOut, reason, stepsDone, eofToExitMs }.
//
// Three rules the driver keeps (PJAN-191; each one was a real flake under CPU load):
//
//  1. The terminal closing is NOT the child exiting. The master reads EIO the moment the last
//     slave fd closes, and a process closes its fds in do_exit() BEFORE it becomes a zombie.
//     The old driver took EIO as "done", polled waitpid(WNOHANG) once, found nothing yet and
//     SIGKILLed a child that was a few milliseconds from exiting 0 -- reporting timedOut with
//     the whole expected output on screen. Now EIO only ends the READING; the exit is awaited
//     (to the settle deadline) and the child's real status is reported. timedOut means the
//     child really did not exit within `settleMs` (or a step never showed up in `timeoutMs`).
//
//  2. A key is written only once the child has put the terminal in raw mode (ICANON off),
//     which is what Ink does -- in the same synchronous effect batch that installs its input
//     handler -- when a screen starts reading keys. Output appearing proves the frame was
//     drawn, not that anyone is listening; the old fixed 50 ms sleep after the match was a
//     guess that load breaks (a key written to a cooked terminal is echoed, ICRNL-rewritten
//     or flushed by the child's own raw-mode switch). A child that reads cooked input sets
//     `ready: false` on the step.
//
//  3. Nothing outlives the run: the child is its own session leader, so its whole process
//     group is SIGKILLed once it is done (a leftover grandchild that still holds the slave
//     can neither stall the final read nor leak), and a SIGTERM to the driver (spawnSync's
//     own timeout) takes the group down with it.

import { spawnSync } from "node:child_process";

const DRIVER = `
import fcntl, json, os, pty, re, select, signal, struct, sys, termios, time
spec = json.loads(sys.argv[1])
pid, fd = pty.fork()
if pid == 0:
    try:
        # size the terminal BEFORE exec: set from the parent it races the child's first ioctl
        fcntl.ioctl(0, termios.TIOCSWINSZ, struct.pack("HHHH", 40, 110, 0, 0))
        os.chdir(spec["cwd"])
        os.execvpe(spec["argv"][0], spec["argv"], spec["env"])
    except BaseException as error:
        os.write(2, ("pty-run: cannot start %r: %s\\n" % (spec["argv"][0], error)).encode())
        os._exit(127)
ansi = re.compile(r"\\x1b\\[[0-9;?]*[A-Za-z]")
buf = b""
eof = False
eof_at = None
exit_seen_at = None
timed_out = False
reason = None
steps_done = 0
status = None
deadline = time.time() + spec["timeout"]

def kill_group():
    for kill, target in ((os.killpg, pid), (os.kill, pid)):
        try:
            kill(target, signal.SIGKILL)
        except (ProcessLookupError, PermissionError):
            pass

def on_term(signum, frame):
    kill_group()
    os._exit(143)
signal.signal(signal.SIGTERM, on_term)

def pump(t):
    global buf, eof, eof_at
    if eof:
        time.sleep(t)
        return
    ready, _, _ = select.select([fd], [], [], t)
    if not ready:
        return
    try:
        data = os.read(fd, 65536)
    except OSError:
        data = b""
    if data:
        buf += data
    else:
        eof = True
        eof_at = time.time()

def text():
    return ansi.sub("", buf.decode("utf8", "replace"))

def exited():
    # WNOWAIT: learn that the child is a zombie without reaping it, so its pid (= its process
    # group id) stays reserved until the group has been killed
    global exit_seen_at
    try:
        found = os.waitid(os.P_PID, pid, os.WEXITED | os.WNOHANG | os.WNOWAIT)
    except ChildProcessError:
        return True
    if found is None:
        return False
    if exit_seen_at is None:
        exit_seen_at = time.time()
    return True

def raw_mode():
    return not (termios.tcgetattr(fd)[3] & termios.ICANON)

def fail(why):
    global timed_out, reason
    timed_out = True
    reason = why

try:
    for index, step in enumerate(spec["steps"]):
        pat = re.compile(step["wait"])
        while not pat.search(text()):
            if eof:
                break
            if time.time() > deadline:
                fail("step %d did not show /%s/ within %d ms" % (index + 1, step["wait"], spec["timeout"] * 1000))
                break
            pump(0.05)
        if timed_out or not pat.search(text()):
            break
        keys = step.get("send")
        if keys:
            if step.get("ready", True):
                while True:
                    try:
                        if raw_mode():
                            break
                    except termios.error:
                        break
                    if eof:
                        break
                    if time.time() > deadline:
                        fail("step %d: /%s/ is on screen but the child never switched the terminal to raw mode (nobody is reading keys) within %d ms" % (index + 1, step["wait"], spec["timeout"] * 1000))
                        break
                    pump(0.01)
                if timed_out:
                    break
            try:
                os.write(fd, keys.encode())
            except OSError:
                break
        steps_done += 1

    if not timed_out:
        settle_deadline = time.time() + spec["settle"]
        while not exited():
            if time.time() >= settle_deadline:
                fail("child still running %d ms after the last step (terminal %s): killed" % (spec["settle"] * 1000, "closed" if eof else "open"))
                break
            pump(0.02)
finally:
    kill_group()
    try:
        _, st = os.waitpid(pid, 0)
        status = os.waitstatus_to_exitcode(st)
    except ChildProcessError:
        status = -1

# the child is gone: take what is still buffered, but never wait on a terminal something else holds open
quiet_by = time.time() + 1.0
while not eof and time.time() < quiet_by:
    ready, _, _ = select.select([fd], [], [], 0.05)
    if not ready:
        break
    pump(0)
lag = None if (eof_at is None or exit_seen_at is None) else max(0, round((exit_seen_at - eof_at) * 1000))
print(json.dumps({"status": status, "output": text(), "timedOut": timed_out, "reason": reason, "stepsDone": steps_done, "eofToExitMs": lag}))
`;

export function runOnPty({ argv, cwd, env, steps, timeoutMs = 20_000, settleMs = 5_000 }) {
  const spec = JSON.stringify({ argv, cwd, env, steps, timeout: timeoutMs / 1000, settle: settleMs / 1000 });
  const result = spawnSync("python3", ["-I", "-c", DRIVER, spec], { encoding: "utf8", timeout: timeoutMs + settleMs + 10_000 });
  if (result.status !== 0) {
    throw new Error(`pty driver failed (status ${result.status}, signal ${result.signal}${result.error ? `, ${result.error.message}` : ""}): ${result.stderr}`);
  }
  return JSON.parse(result.stdout);
}
