import { randomUUID } from "node:crypto";
import {
  closeSync, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync,
  readSync, renameSync, unlinkSync, writeFileSync,
} from "node:fs";
import type { BigIntStats } from "node:fs";
import path from "node:path";
import { promptHash } from "./agent-trace.js";
import {
  BUSINESS_PROMPT_DEFAULTS, createBusinessPromptOverrides, previewBusinessPrompt,
  type BusinessPromptOverrides,
} from "./prompt-preview.js";

interface OfflineOnly {
  applied: false;
  authorized: false;
  executable: false;
}
type BusinessSection = keyof typeof BUSINESS_PROMPT_DEFAULTS;
type BusinessDefaults = Record<BusinessSection, { text: string; hash: string }>;
interface StoredSnapshot {
  revision: number;
  previousRevision: number | null;
  savedAt: number;
  source: string;
  defaultsRevision: string;
  overrides: BusinessPromptOverrides;
  /** Locally observed defaults only; hashes are not trusted provenance. */
  businessDefaults?: BusinessDefaults;
  previewRevision: string;
}
export interface BusinessPromptSnapshot extends StoredSnapshot, OfflineOnly {}
export interface BusinessPromptHistorySummary extends Omit<StoredSnapshot, "overrides" | "businessDefaults">, OfflineOnly {}
export interface BusinessPromptDefaultChanges extends OfflineOnly {
  revision: number;
  items: {
    section: BusinessSection;
    baseHash: string | null;
    currentHash: string;
    status: "known" | "unknown";
    drifted: boolean | null;
    previousText?: string;
    currentText: string;
  }[];
}
export interface BusinessPromptHistoryRead extends OfflineOnly {
  revision: number;
  /** Newest first. Empty history has revision zero. */
  items: BusinessPromptHistorySummary[];
}
export interface BusinessPromptHistorySaveInput {
  expectedRevision: number;
  source: string;
  overrides: BusinessPromptOverrides;
}

const MAX_BYTES = 1024 * 1024;
const MAX_REVISIONS = 32;
const FIELDS = ["revision", "previousRevision", "savedAt", "source", "defaultsRevision", "overrides", "previewRevision"];
const OFFLINE = { applied: false, authorized: false, executable: false } as const;
type Failure = "INVALID_INPUT" | "STORAGE_FAILED" | "INVALID_STATE" | "STALE_REVISION" | "BUSY" | "FULL" | "NOT_FOUND";
function fail(code: Failure): never {
  // Never include paths, underlying IO causes, property names or business text.
  throw new Error("PROMPT_HISTORY_" + code);
}
function integer(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}
function hash(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
}
function source(value: unknown): value is string {
  return typeof value === "string" && value.length <= 256 && !!value.trim() &&
    !/[\u0000-\u001f\u007f-\u009f]/.test(value) &&
    Buffer.from(value, "utf8").toString("utf8") === value;
}
function object(raw: unknown, fields: readonly string[], optional: readonly string[] = []): Record<string, unknown> {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) throw Error();
  const proto = Object.getPrototypeOf(raw);
  if (proto !== Object.prototype && proto !== null) throw Error();
  const result: Record<string, unknown> = Object.create(null);
  const keys = Reflect.ownKeys(raw);
  if (fields.some((key) => !keys.includes(key))) throw Error();
  for (const key of keys) {
    if (typeof key !== "string" || (!fields.includes(key) && !optional.includes(key))) throw Error();
    const descriptor = Object.getOwnPropertyDescriptor(raw, key)!;
    if (!("value" in descriptor) || !descriptor.enumerable) throw Error();
    result[key] = descriptor.value;
  }
  return result;
}
function overrides(raw: unknown): BusinessPromptOverrides {
  // Preview strictly checks all override keys and preserves supplied base hashes.
  const checked = previewBusinessPrompt({ overrides: raw }).overrides;
  const texts: Record<string, string> = {};
  for (const section of ["communication", "delivery"] as const) {
    if (checked[section]) texts[section] = checked[section]!.text;
  }
  // Reuse the factory's text validation, without rebasing the saved overrides.
  createBusinessPromptOverrides(texts);
  return checked;
}
function businessDefaults(raw: unknown): BusinessDefaults {
  const input = object(raw, ["communication", "delivery"]);
  const result = {} as BusinessDefaults;
  for (const section of ["communication", "delivery"] as const) {
    const entry = object(input[section], ["text", "hash"]);
    // Reuse the bounded business-text validator, including UTF-16 validation.
    const checked = createBusinessPromptOverrides({ [section]: entry.text })[section]!;
    if (!hash(entry.hash) || promptHash(checked.text) !== entry.hash) throw Error();
    result[section] = { text: checked.text, hash: entry.hash };
  }
  return result;
}
function observedDefaults(): BusinessDefaults {
  return businessDefaults(Object.fromEntries(
    Object.entries(BUSINESS_PROMPT_DEFAULTS).map(([section, text]) => [section, { text, hash: promptHash(text) }]),
  ));
}
function snapshot(raw: unknown, index: number, previousTime: number): StoredSnapshot {
  const r = object(raw, FIELDS, ["businessDefaults"]);
  if (r.revision !== index + 1 || r.previousRevision !== (index === 0 ? null : index) ||
      !integer(r.savedAt) || r.savedAt <= previousTime || !source(r.source) ||
      !hash(r.defaultsRevision) || !hash(r.previewRevision)) throw Error();
  const checked = overrides(r.overrides);
  // Exactly the preview algorithm, using the ORIGINAL defaults revision, not today's.
  if (r.previewRevision !== promptHash(JSON.stringify([r.defaultsRevision, checked]))) throw Error();
  return {
    revision: index + 1, previousRevision: index === 0 ? null : index,
    savedAt: r.savedAt, source: r.source, defaultsRevision: r.defaultsRevision,
    overrides: checked, previewRevision: r.previewRevision,
    ...(Object.hasOwn(r, "businessDefaults") ? { businessDefaults: businessDefaults(r.businessDefaults) } : {}),
  };
}
function expose(record: StoredSnapshot): BusinessPromptSnapshot {
  return {
    ...record, overrides: overrides(record.overrides),
    ...(record.businessDefaults ? { businessDefaults: businessDefaults(record.businessDefaults) } : {}),
    ...OFFLINE,
  };
}

/** Host-only local persistence. No model tools, live Worker wiring, apply or authorization.
 * root must be a private host-owned directory: this cooperative lock is not a sandbox.
 * Crash/stale locks are never stolen; reconcile them offline with all writers stopped.
 * Stores original defaultsRevision, supplied override baseHash and observed business
 * defaults, never security text. Legacy records without defaults remain readable.
 * Local files/hashes are not trusted provenance or full prompt reproduction.
 * Reading old records never requires today's defaults hash.
 * A failed save may have committed before cleanup failed; reread before retrying CAS.
 */
export class BusinessPromptHistory {
  private readonly target: string;
  private readonly lock: string;

  constructor(root: string) {
    if (typeof root !== "string" || !root.trim() || /[\u0000-\u001f]/.test(root) ||
        Buffer.from(root, "utf8").toString("utf8") !== root) fail("INVALID_INPUT");
    try {
      const directory = path.resolve(root);
      mkdirSync(directory, { recursive: true, mode: 0o700 });
      if (!lstatSync(directory).isDirectory() || lstatSync(directory).isSymbolicLink()) throw Error();
      this.target = path.join(directory, "business-prompt-history.json");
      this.lock = path.join(directory, ".business-prompt-history.lock");
    } catch { fail("STORAGE_FAILED"); }
  }

  read(): BusinessPromptHistoryRead {
    return this.locked(() => {
      const records = this.load();
      const items = records.slice().reverse().map((record) => {
        const { overrides: _overrides, businessDefaults: _defaults, ...summary } = record;
        return { ...summary, ...OFFLINE };
      });
      return { revision: records.length, items, ...OFFLINE };
    });
  }

  history(): BusinessPromptHistorySummary[] {
    return this.read().items;
  }

  get(revision: number): BusinessPromptSnapshot {
    if (!integer(revision) || revision < 1) fail("INVALID_INPUT");
    return this.locked(() => {
      const record = this.load()[revision - 1];
      if (!record) fail("NOT_FOUND");
      return expose(record);
    });
  }

  /** Offline before/current data, not an apply operation or a provenance claim.
   * Lookup is section-specific by the supplied baseline hash, not defaultsRevision.
   * Legacy records cannot claim an observed baseline, even if today happens to match.
   */
  defaultChanges(revision: number): BusinessPromptDefaultChanges {
    if (!integer(revision) || revision < 1) fail("INVALID_INPUT");
    return this.locked(() => {
      const records = this.load();
      const record = records[revision - 1];
      if (!record) fail("NOT_FOUND");
      const current = observedDefaults();
      const items = (["communication", "delivery"] as const).map((section) => {
        const baseHash = record.overrides[section]?.baseHash ?? record.businessDefaults?.[section].hash ?? null;
        const previous = record.businessDefaults
          ? records.map((item) => item.businessDefaults?.[section]).find((item) => item?.hash === baseHash)
          : undefined;
        return {
          section, baseHash, currentHash: current[section].hash,
          status: previous ? "known" as const : "unknown" as const,
          drifted: baseHash === null ? null : baseHash !== current[section].hash,
          ...(previous ? { previousText: previous.text } : {}),
          currentText: current[section].text,
        };
      });
      return { revision, items, ...OFFLINE };
    });
  }

  save(raw: BusinessPromptHistorySaveInput): BusinessPromptSnapshot {
    let input: Record<string, unknown>;
    let checked: BusinessPromptOverrides;
    try {
      input = object(raw, ["expectedRevision", "source", "overrides"]);
      if (!integer(input.expectedRevision) || !source(input.source)) throw Error();
      checked = overrides(input.overrides);
    } catch { fail("INVALID_INPUT"); }
    return this.locked(() => {
      const records = this.load();
      if (input.expectedRevision !== records.length) fail("STALE_REVISION");
      if (records.length >= MAX_REVISIONS) fail("FULL");
      const previousTime = records.at(-1)?.savedAt ?? -1;
      const now = Date.now();
      if (!integer(now) || previousTime >= Number.MAX_SAFE_INTEGER) fail("INVALID_STATE");
      const preview = previewBusinessPrompt({ overrides: checked });
      const record: StoredSnapshot = {
        revision: records.length + 1,
        previousRevision: records.length || null,
        savedAt: Math.max(now, previousTime + 1),
        source: input.source as string,
        defaultsRevision: preview.defaultsRevision,
        overrides: preview.overrides,
        businessDefaults: observedDefaults(),
        previewRevision: preview.revision,
      };
      this.persist([...records, record]);
      return expose(record);
    });
  }

  private locked<T>(action: () => T): T {
    let fd: number;
    try { fd = openSync(this.lock, "wx", 0o600); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") fail("BUSY");
      fail("STORAGE_FAILED");
    }
    let identity: BigIntStats | undefined;
    try {
      try {
        identity = fstatSync(fd, { bigint: true });
        writeFileSync(fd, JSON.stringify({ version: 1, token: randomUUID() }), "utf8");
        fsyncSync(fd);
      } catch { fail("STORAGE_FAILED"); }
      return action();
    } finally {
      let failed = false;
      try { closeSync(fd); } catch { failed = true; }
      try {
        const current = lstatSync(this.lock, { bigint: true });
        if (!identity || !current.isFile() || current.dev !== identity.dev || current.ino !== identity.ino) throw Error();
        unlinkSync(this.lock);
      } catch { failed = true; }
      if (failed) fail("STORAGE_FAILED");
    }
  }

  private load(): StoredSnapshot[] {
    let link: BigIntStats;
    try { link = lstatSync(this.target, { bigint: true }); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      fail("STORAGE_FAILED");
    }
    if (!link.isFile() || link.size > BigInt(MAX_BYTES)) fail("INVALID_STATE");
    let fd: number;
    try { fd = openSync(this.target, "r"); } catch { fail("STORAGE_FAILED"); }
    try {
      let json: string;
      try {
        const before = fstatSync(fd, { bigint: true });
        if (!before.isFile() || before.size > BigInt(MAX_BYTES) ||
            before.dev !== link.dev || before.ino !== link.ino) fail("INVALID_STATE");
        const bytes = Buffer.alloc(Number(before.size) + 1);
        let length = 0;
        while (length < bytes.length) {
          const count = readSync(fd, bytes, length, bytes.length - length, null);
          if (!count) break;
          length += count;
        }
        const after = fstatSync(fd, { bigint: true });
        if (length !== Number(before.size) || before.size !== after.size ||
            before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs) fail("INVALID_STATE");
        json = new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, length));
      } catch { fail("INVALID_STATE"); }
      try {
        const raw = object(JSON.parse(json), ["version", "items"]);
        if (raw.version !== 1 || !Array.isArray(raw.items) || raw.items.length < 1 || raw.items.length > MAX_REVISIONS) throw Error();
        const records: StoredSnapshot[] = [];
        for (const item of raw.items) records.push(snapshot(item, records.length, records.at(-1)?.savedAt ?? -1));
        return records;
      } catch { return fail("INVALID_STATE"); }
    } finally {
      try { closeSync(fd); } catch { fail("STORAGE_FAILED"); }
    }
  }

  private persist(records: StoredSnapshot[]): void {
    const temp = this.target + "." + randomUUID() + ".tmp";
    let fd: number | undefined;
    let created = false;
    const json = JSON.stringify({ version: 1, items: records });
    if (Buffer.byteLength(json, "utf8") > MAX_BYTES) fail("FULL");
    try {
      fd = openSync(temp, "wx", 0o600);
      created = true;
      writeFileSync(fd, json, "utf8");
      fsyncSync(fd);
      const closing = fd;
      fd = undefined;
      closeSync(closing);
      renameSync(temp, this.target);
      created = false;
    } catch { fail("STORAGE_FAILED"); }
    finally {
      let failed = false;
      if (fd !== undefined) { try { closeSync(fd); } catch { failed = true; } }
      if (created) { try { unlinkSync(temp); } catch { failed = true; } }
      if (failed) fail("STORAGE_FAILED");
    }
  }
}
