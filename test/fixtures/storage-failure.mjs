// Test-only diagnostics: never print messages, stacks, paths, or payloads.
const codes = new Set(["EACCES", "EPERM", "ENOENT", "EEXIST", "EBUSY", "ENOSPC", "EIO", "EMFILE", "ENFILE", "EINVAL", "RUNTIME_STORAGE_FAILED"]);
const syscalls = new Set(["open", "write", "fsync", "close", "rename", "unlink", "rmdir", "mkdir", "stat", "lstat", "fstat", "read", "scandir"]);
function own(value, key) {
  if (!value || typeof value !== "object") return undefined;
  try { return Object.getOwnPropertyDescriptor(value, key)?.value; } catch { return undefined; }
}
export function storageFailureSummary(error) {
  const chain = [];
  const seen = new Set();
  for (let depth = 0; error && depth < 4 && !seen.has(error); depth++) {
    seen.add(error);
    const code = own(error, "code");
    const syscall = own(error, "syscall");
    chain.push({ code: codes.has(code) ? code : "unknown", syscall: syscalls.has(syscall) ? syscall : "unknown" });
    error = own(error, "cause");
  }
  return JSON.stringify({ operation: "checkpoint-save", chain });
}
