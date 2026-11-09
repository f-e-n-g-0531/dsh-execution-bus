import { WORKER_ROLE_INSTRUCTIONS, promptHash } from "./agent-trace.js";

/** Offline only. These business defaults are not the live Worker prompt. */
export const BUSINESS_PROMPT_DEFAULTS = Object.freeze({
  communication:
    "Communicate concisely, using the task's language. Separate facts from uncertainty.",
  delivery:
    "Summarize the result, supporting evidence, and remaining limitations.",
});
export const BUSINESS_PROMPT_MAX_SECTION_BYTES = 8192;
const SECTIONS = ["communication", "delivery"] as const;
type Section = (typeof SECTIONS)[number];
export interface BusinessPromptOverride {
  text: string;
  /** SHA-256 of this section's default when the override was authored. Not provenance proof. */
  baseHash: string;
}
export type BusinessPromptOverrides = Partial<
  Record<Section, BusinessPromptOverride>
>;
export interface BusinessPromptPreviewInput {
  overrides?: BusinessPromptOverrides;
  /** Optional optimistic check against the current runtime-owned defaults revision. */
  baseRevision?: string;
}
export interface BusinessPromptPreview {
  kind: "offline_business_prompt_preview";
  applied: false;
  authorized: false;
  executable: false;
  defaultsRevision: string;
  revision: string;
  security: { source: "WORKER_ROLE_INSTRUCTIONS"; text: string; hash: string };
  business: Record<
    Section,
    {
      text: string;
      source: "default" | "override";
      defaultHash: string;
      baseHash: string;
      drifted: boolean;
    }
  >;
  overrides: BusinessPromptOverrides;
  /** Inspection text only; never passed to a model by this module. */
  text: string;
  limitations: readonly string[];
}

function invalid(): never {
  // Do not echo caller-supplied text, property names, or values into errors.
  throw new Error("PROMPT_PREVIEW_INVALID_INPUT");
}
function object(
  raw: unknown,
  allowed: readonly string[],
): Record<string, unknown> {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) invalid();
  const proto = Object.getPrototypeOf(raw);
  if (proto !== Object.prototype && proto !== null) invalid();
  const result: Record<string, unknown> = Object.create(null);
  for (const key of Reflect.ownKeys(raw)) {
    if (typeof key !== "string" || !allowed.includes(key)) invalid();
    const descriptor = Object.getOwnPropertyDescriptor(raw, key)!;
    if (!("value" in descriptor) || !descriptor.enumerable) invalid();
    result[key] = descriptor.value;
  }
  return result;
}
function hash(raw: unknown): string {
  if (typeof raw !== "string" || !/^[a-f0-9]{64}$/.test(raw)) invalid();
  return raw;
}
function text(raw: unknown): string {
  if (
    typeof raw !== "string" ||
    !raw.trim() ||
    Buffer.byteLength(raw, "utf8") > BUSINESS_PROMPT_MAX_SECTION_BYTES ||
    /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(raw)
  )
    invalid();
  // Reject lone surrogates; distinct invalid UTF-16 strings must not share a UTF-8 hash.
  for (let i = 0; i < raw.length; i++) {
    const unit = raw.charCodeAt(i);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = raw.charCodeAt(++i);
      if (!(next >= 0xdc00 && next <= 0xdfff)) invalid();
    } else if (unit >= 0xdc00 && unit <= 0xdfff) invalid();
  }
  return raw;
}
function defaultsRevision(): string {
  return promptHash(
    JSON.stringify([
      "offline-business-prompt-v1",
      WORKER_ROLE_INSTRUCTIONS,
      BUSINESS_PROMPT_DEFAULTS.communication,
      BUSINESS_PROMPT_DEFAULTS.delivery,
    ]),
  );
}
function checkRevision(raw: Record<string, unknown>, expected: string): void {
  if (
    Object.hasOwn(raw, "baseRevision") &&
    hash(raw.baseRevision) !== expected
  ) {
    throw new Error("PROMPT_PREVIEW_STALE_REVISION");
  }
}
function parseOverrides(raw: unknown): BusinessPromptOverrides {
  const input = object(raw, SECTIONS);
  const result: BusinessPromptOverrides = {};
  for (const section of SECTIONS) {
    if (!Object.hasOwn(input, section)) continue;
    const entry = object(input[section], ["text", "baseHash"]);
    result[section] = {
      text: text(entry.text),
      baseHash: hash(entry.baseHash),
    };
  }
  return result;
}

/** Stamp new overrides against current local defaults. No save/apply/authorization occurs. */
export function createBusinessPromptOverrides(
  raw: unknown = {},
): BusinessPromptOverrides {
  const input = object(raw, [...SECTIONS, "baseRevision"]);
  checkRevision(input, defaultsRevision());
  const result: BusinessPromptOverrides = {};
  for (const section of SECTIONS) {
    if (Object.hasOwn(input, section)) {
      result[section] = {
        text: text(input[section]),
        baseHash: promptHash(BUSINESS_PROMPT_DEFAULTS[section]),
      };
    }
  }
  return result;
}

/** Pure bounded host API. Custom text is untrusted business data, not a security policy. */
export function previewBusinessPrompt(
  raw: unknown = {},
): BusinessPromptPreview {
  const input = object(raw, ["overrides", "baseRevision"]);
  const currentRevision = defaultsRevision();
  checkRevision(input, currentRevision);
  const overrides = Object.hasOwn(input, "overrides")
    ? parseOverrides(input.overrides)
    : {};
  const business = {} as BusinessPromptPreview["business"];
  for (const section of SECTIONS) {
    const override = overrides[section];
    const defaultHash = promptHash(BUSINESS_PROMPT_DEFAULTS[section]);
    business[section] = {
      text: override?.text ?? BUSINESS_PROMPT_DEFAULTS[section],
      source: override ? "override" : "default",
      defaultHash,
      baseHash: override?.baseHash ?? defaultHash,
      drifted: !!override && override.baseHash !== defaultHash,
    };
  }
  const security = {
    source: "WORKER_ROLE_INSTRUCTIONS" as const,
    text: WORKER_ROLE_INSTRUCTIONS,
    hash: promptHash(WORKER_ROLE_INSTRUCTIONS),
  };
  return {
    kind: "offline_business_prompt_preview",
    applied: false,
    authorized: false,
    executable: false,
    defaultsRevision: currentRevision,
    revision: promptHash(JSON.stringify([currentRevision, overrides])),
    security,
    business,
    overrides,
    text:
      "OFFLINE PREVIEW ONLY — NOT APPLIED, NOT AUTHORIZED, NOT EXECUTABLE.\n\n" +
      security.text +
      "\n\n[Untrusted business communication]\n" +
      business.communication.text +
      "\n\n[Untrusted business delivery]\n" +
      business.delivery.text,
    limitations: [
      "This is not the complete host or Worker execution prompt and changes no running Worker.",
      "Business text is not semantically verified safe; it cannot replace the local security section.",
      "Hashes detect supplied baseline differences, not authorship, approval, or trusted historical provenance.",
      "This preview function has no persistence; use the explicit host-only BusinessPromptHistory separately for saved revisions.",
    ],
  };
}

/** Compare two supplied configurations under current defaults, not persisted history.
 * baseRevision, if present, must equal the before preview revision (optimistic stale-input guard).
 * Neither preview is applied; drift means an override's supplied base hash differs from today's default.
 */
export function compareBusinessPrompts(raw: unknown): {
  kind: "offline_business_prompt_comparison";
  applied: false;
  authorized: false;
  beforeRevision: string;
  afterRevision: string;
  defaultsRevision: string;
  changedSections: Section[];
  baselineChangedSections: Section[];
  driftedSections: { before: Section[]; after: Section[] };
} {
  const input = object(raw, ["before", "after", "baseRevision"]);
  if (!Object.hasOwn(input, "before") || !Object.hasOwn(input, "after"))
    invalid();
  const before = previewBusinessPrompt(input.before);
  const after = previewBusinessPrompt(input.after);
  checkRevision(input, before.revision);
  return {
    kind: "offline_business_prompt_comparison",
    applied: false,
    authorized: false,
    beforeRevision: before.revision,
    afterRevision: after.revision,
    defaultsRevision: before.defaultsRevision,
    changedSections: SECTIONS.filter(
      (s) =>
        before.business[s].text !== after.business[s].text ||
        before.business[s].source !== after.business[s].source,
    ),
    baselineChangedSections: SECTIONS.filter(
      (s) => before.business[s].baseHash !== after.business[s].baseHash,
    ),
    driftedSections: {
      before: SECTIONS.filter((s) => before.business[s].drifted),
      after: SECTIONS.filter((s) => after.business[s].drifted),
    },
  };
}
