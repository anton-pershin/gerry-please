import { afterEach, describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { InstanceLock } from "../src/instance-lock.ts";
import { temporaryDirectory } from "./helpers.ts";

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("single instance lock", () => {
  test("rejects a live second daemon and permits reuse after release", () => {
    const directory = temporaryDirectory();
    directories.push(directory);
    const first = InstanceLock.acquire(directory);
    expect(() => InstanceLock.acquire(directory)).toThrow("already serving");
    first.release();
    const second = InstanceLock.acquire(directory);
    second.release();
  });
});
