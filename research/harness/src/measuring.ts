// One measurement at a time on this host. Two explores sharing the machine
// measure each other, so every grader command that measures holds this lock
// for the life of its process. A holder whose process is gone is reclaimed;
// a live holder is never overridden.
import * as fs from "node:fs";
import * as path from "node:path";
import { ROOT } from "./paths.js";

const LOCK_PATH = path.join(ROOT, "tmp", "loop", "measuring.lock");
// A lock file is written in two steps (create, then fill), so an unreadable
// one younger than this may be a holder that has not finished writing it.
const UNREADABLE_GRACE_MS = 10_000;

interface Holder {
  loop: string;
  command: string;
  name: string | null;
  pid: number;
  startedAt: string;
}

function describe(h: Holder): string {
  const what = [h.loop, h.command, h.name].filter((x) => x !== null && x !== "").join(" ");
  return `${what} (pid ${h.pid}, since ${h.startedAt})`;
}

function readHolder(): Holder | null {
  try {
    const h = JSON.parse(fs.readFileSync(LOCK_PATH, "utf8")) as Partial<Holder>;
    if (typeof h.pid !== "number" || typeof h.loop !== "string" || typeof h.command !== "string") return null;
    return { loop: h.loop, command: h.command, name: h.name ?? null, pid: h.pid, startedAt: h.startedAt ?? "unknown" };
  } catch {
    return null;
  }
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM means the process exists under another user.
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

function release(): void {
  const h = readHolder();
  if (h !== null && h.pid === process.pid) fs.rmSync(LOCK_PATH, { force: true });
}

let held = false;

/** Take the host measuring lock or throw naming its live holder. Released
 *  when this process exits, including on SIGINT, SIGTERM and SIGHUP. */
export function holdMeasuringLock(loop: string, command: string, name: string | null | undefined): void {
  if (held) return;
  fs.mkdirSync(path.dirname(LOCK_PATH), { recursive: true });
  const me: Holder = { loop, command, name: name ?? null, pid: process.pid, startedAt: new Date().toISOString() };
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      fs.writeFileSync(LOCK_PATH, JSON.stringify(me) + "\n", { flag: "wx" });
      held = true;
      process.on("exit", release);
      for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
        process.once(sig, () => {
          release();
          process.kill(process.pid, sig);
        });
      }
      return;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
    }
    const h = readHolder();
    if (h === null) {
      let ageMs = Infinity;
      try {
        ageMs = Date.now() - fs.statSync(LOCK_PATH).mtimeMs;
      } catch {
        continue;
      }
      if (ageMs < UNREADABLE_GRACE_MS) {
        throw new Error(`${LOCK_PATH} is being taken by another measurement; retry in a few seconds`);
      }
      console.error(`[measuring] reclaiming an unreadable lock file ${LOCK_PATH}`);
    } else if (alive(h.pid)) {
      throw new Error(`${describe(h)} is measuring on this host; two measurements on one host measure each other. Wait for it, or stop it, before measuring.`);
    } else {
      console.error(`[measuring] reclaiming a stale lock left by ${describe(h)}, whose process is gone`);
    }
    fs.rmSync(LOCK_PATH, { force: true });
  }
  throw new Error(`could not take ${LOCK_PATH}`);
}
