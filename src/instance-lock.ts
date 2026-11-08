import { closeSync, existsSync, mkdirSync, openSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { hostname } from "node:os";
import { id, iso } from "./util.ts";

interface LockContents {
  token: string;
  pid: number;
  host: string;
  acquiredAt: string;
}

export class InstanceLock {
  private constructor(
    private readonly path: string,
    private readonly token: string,
  ) {}

  static acquire(dataDirectory: string): InstanceLock {
    mkdirSync(dataDirectory, { recursive: true });
    const path = join(dataDirectory, "serve.lock");
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const token = id("lock");
      const contents: LockContents = { token, pid: process.pid, host: hostname(), acquiredAt: iso() };
      try {
        const descriptor = openSync(path, "wx", 0o600);
        writeFileSync(descriptor, JSON.stringify(contents), "utf8");
        closeSync(descriptor);
        return new InstanceLock(path, token);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      }

      let stale = false;
      try {
        const existing = JSON.parse(readFileSync(path, "utf8")) as Partial<LockContents>;
        if (existing.host !== hostname() || !Number.isInteger(existing.pid)) {
          throw new Error(`Data directory is locked by ${existing.host ?? "an unknown host"}: ${path}`);
        }
        try {
          process.kill(existing.pid!, 0);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ESRCH") stale = true;
          else if ((error as NodeJS.ErrnoException).code !== "EPERM") throw error;
        }
      } catch (error) {
        if (error instanceof SyntaxError) stale = true;
        else throw error;
      }
      if (!stale) throw new Error(`Another Gerry process is already serving this data directory: ${path}`);
      unlinkSync(path);
    }
    throw new Error(`Could not acquire data-directory lock: ${path}`);
  }

  release(): void {
    if (!existsSync(this.path)) return;
    try {
      const contents = JSON.parse(readFileSync(this.path, "utf8")) as Partial<LockContents>;
      if (contents.token === this.token) unlinkSync(this.path);
    } catch {
      // Never remove an unreadable lock that another process may have replaced.
    }
  }
}
