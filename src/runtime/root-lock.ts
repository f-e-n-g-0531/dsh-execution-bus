import { randomUUID } from "node:crypto";
import {
  openSync,
  closeSync,
  writeFileSync,
  fsyncSync,
  fstatSync,
  lstatSync,
  unlinkSync,
} from "node:fs";
import type { BigIntStats } from "node:fs";
import path from "node:path";
import { ERRORS } from "../error-codes.js";

/** Cooperative local-process exclusion, not a sandbox or distributed lease.
 * Never steals a lock: even a dead PID or old timestamp requires operator reconciliation. */
export function acquireRootLock(root: string): () => void {
  const target = path.join(root, ".runtime-owner.lock");
  let fd: number;
  try {
    fd = openSync(target, "wx", 0o600);
  } catch (error) {
    throw Error(
      (error as NodeJS.ErrnoException).code === "EEXIST"
        ? ERRORS.RUNTIME_ROOT_LOCKED
        : ERRORS.RUNTIME_STORAGE_FAILED,
    );
  }
  let identity: BigIntStats | undefined;
  const removeOwn = () => {
    const current = lstatSync(target, { bigint: true });
    if (
      !identity ||
      !current.isFile() ||
      current.dev !== identity.dev ||
      current.ino !== identity.ino
    )
      throw Error(ERRORS.RUNTIME_ROOT_LOCKED);
    unlinkSync(target);
  };
  let failed = false;
  try {
    identity = fstatSync(fd, { bigint: true });
    writeFileSync(
      fd,
      JSON.stringify({
        version: 1,
        pid: process.pid,
        token: randomUUID(),
        createdAt: Date.now(),
      }),
      "utf8",
    );
    fsyncSync(fd);
  } catch {
    failed = true;
  }
  // Always attempt close, including fstat failure. Do not retry close: the OS
  // may already have closed/reused the descriptor even when it reports failure.
  try {
    closeSync(fd);
  } catch {
    failed = true;
  }
  if (failed) {
    try {
      removeOwn();
    } catch {
      /* Unknown identity/removal stays fail-closed. */
    }
    throw Error(ERRORS.RUNTIME_STORAGE_FAILED);
  }
  let released = false;
  return () => {
    if (released) return;
    try {
      removeOwn();
    } catch {
      throw Error(ERRORS.RUNTIME_ROOT_LOCKED);
    }
    released = true;
  };
}
