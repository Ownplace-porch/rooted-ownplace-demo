// Shared timeline library: story package construction, index read/rebuild,
// and publishing to the author's own porch (M15 #100). Used by the CLI (`post.ts`)
// and the web write API (`apps/ownplace-web/src/server.ts`) so both write
// through the SAME lane. Slice-2 paid gating: optional multi-reader sealed bodies via publishStory entitle/entitleReaders opts; web API stays public-only.
// Slice-3 paid gating: gated packages also carry a signed entitlements.json
// sidecar ({ storyId, entitled: [{ readerId }] }, ids only, no keys) bound by
// the manifest hash plus Ed25519 signature; public posts carry no sidecar.

import { randomBytes } from "node:crypto";
import {
  createManifest,
  hashObject,
  loadOrCreateIdentity,
  signManifest,
  verifyManifestSignature,
  objectBytes,
  type Kinfolk,
  type Story,
} from "@rooted/protocol";
import { identityFingerprint, isFingerprint, isMediaList, isSafeReaderId, isSealedBody, loadOrCreateEncryptionIdentity, sealBodyForReaders, sealGatedContent, tryOpenBody } from "@rooted/protocol";
// Re-exported for the web reader gate (M8 #66): same reader-id rule server-side.
export { isSafeReaderId } from "@rooted/protocol";
import { HttpsPorchStore, LocalFolderStore, WebDavStore, type ObjectStore } from "@rooted/storage";
import { lstat, mkdir, realpath } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);

export interface TimelineEntry {
  id: string;
  title: string;
  authorId: string;
  createdAt: string;
  verified?: boolean;
  // Follow-model broadcast (M10 demo): which porch an entry was pulled
  // from. Own-porch reads leave it unset; merged reads set it.
  origin?: string;
}
export interface TimelineIndex {
  protocol: "rooted/v0.1";
  kind: "timeline";
  updatedAt: string;
  stories: TimelineEntry[];
  skipped?: { id: string; reason: string }[];
}

export interface Contact {
  id: string;
  displayName: string;
  addedAt: string;
  // M10 #75: where the followed porch lives. Optional on read so contacts
  // written before this field still load. Required on new adds.
  address?: string;
  // M12 #92: signer key fingerprint confirmed at follow-by-invite time.
  fingerprint?: string;
  // M13 #94: the invite this contact was followed by; re-resolved on a move.
  invite?: string;
}
export interface ContactList {
  protocol: "rooted/v0.1";
  kind: "contacts";
  updatedAt: string;
  contacts: Contact[];
}

export interface StoryInput {
  title: string;
  body: string;
  media?: string[];
  authorId?: string;
  authorName?: string;
  createdAt?: string;
}

export interface PublishResult {
  storyId: string;
  authorId: string;
  backends: string[];
  skipped: string[];
}

// M15 #100: two Kinfolk, one cloud each. Each demo Kinfolk owns one porch
// (a local sim) and, when enabled, the one real cloud that porch maps to.
// Nothing is mirrored between them; they meet only by following each other.
export interface DemoKinfolk {
  id: string;
  displayName: string;
  bio: string;
  porch: "nextcloud-sim" | "google-drive-sim";
  cloud: "kevcloud" | "google-drive";
}

export const DEMO_KINFOLK: readonly DemoKinfolk[] = [
  { id: "kinfolk-alex", displayName: "Alex Rowan", bio: "Building a more rooted internet.", porch: "nextcloud-sim", cloud: "kevcloud" },
  { id: "kinfolk-sam", displayName: "Sam", bio: "Keeping a porch on a different cloud.", porch: "google-drive-sim", cloud: "google-drive" },
];

// The web operator (single write token) is this Kinfolk and posts only as them.
export const OPERATOR_KINFOLK = "kinfolk-alex";

export const NO_PORCH = "author has no porch in this demo";

export function demoKinfolkFor(authorId: string): DemoKinfolk | undefined {
  return DEMO_KINFOLK.find((k) => k.id === authorId);
}

// Library callers publishing as any other Kinfolk (tests, fixtures) get one
// porch, never a mirror. The demo CLI and web API refuse such authors.
const DEFAULT_PORCH: Pick<DemoKinfolk, "porch" | "cloud"> = { porch: "nextcloud-sim", cloud: "kevcloud" };

export const TITLE_MAX = 140;
export const BODY_MAX = 5000;

export function validateInput(input: StoryInput): { title: string; body: string; media: string[]; authorId: string; authorName: string } {
  const { title, body } = input;
  if (typeof title !== "string" || !title.trim() || typeof body !== "string" || !body.trim()) {
    throw new Error("title and body are required and must be non-empty");
  }
  const cleanTitle = title.trim();
  const cleanBody = body.trim();
  if (cleanTitle.length > TITLE_MAX) throw new Error(`title too long: max ${TITLE_MAX} characters`);
  if (cleanBody.length > BODY_MAX) throw new Error(`body too long: max ${BODY_MAX} characters`);
  if (input.authorId !== undefined && typeof input.authorId !== "string") throw new Error("author-id must be a string");
  if (input.authorName !== undefined && typeof input.authorName !== "string") throw new Error("author-name must be a string");
  const rawAuthorId = typeof input.authorId === "string" ? input.authorId : OPERATOR_KINFOLK;
  // M15 #100: a demo Kinfolk posting without a name keeps their own name.
  const rawAuthorName = typeof input.authorName === "string"
    ? input.authorName
    : (DEMO_KINFOLK.find((k) => k.id === rawAuthorId.trim())?.displayName ?? "Alex Rowan");
  const authorId = rawAuthorId.trim();
  const authorName = rawAuthorName.trim();
  if (!authorId || !authorName) throw new Error("author-id and author-name must be non-empty");
  if (authorId.includes("/") || authorId.includes("\\") || authorId.includes("..")) {
    throw new Error("author-id contains unsafe characters");
  }
  // M8 #65: publisher-supplied media pointers. Same readers as the body when
  // gated (no per-audience partitioning per #58); public flow leaves clear
  // media empty as before.
  const media = input.media === undefined ? [] : input.media;
  if (!isMediaList(media)) throw new Error("media must be a list of at most 8 https URLs");
  return { title: cleanTitle, body: cleanBody, media, authorId, authorName };
}

export function isEntry(s: unknown): s is TimelineEntry {
  if (typeof s !== "object" || s === null) return false;
  const e = s as Record<string, unknown>;
  return (
    typeof e.id === "string" && e.id.length > 0 &&
    typeof e.title === "string" &&
    typeof e.authorId === "string" && e.authorId.length > 0 &&
    typeof e.createdAt === "string" && !Number.isNaN(Date.parse(e.createdAt))
  );
}

export function sortTimeline(stories: TimelineEntry[]): void {
  stories.sort((a, b) => b.createdAt.localeCompare(a.createdAt) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

export function isSafeHistoryId(id: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(id);
}

const HISTORY_FILES = ["kinfolk.json", "story.json", "manifest.json", "signature.json"] as const;

// Slice-3 signed sidecar: ids only, no keys/secrets. Gated packages list it
// in the manifest (hash + Ed25519 bound like kinfolk/story); public posts
// emit no such file. Optional on read: required for gated packages,
// forbidden for public ones (enforced in fetchVerifiedHistoryPackage).
export const ENTITLEMENTS_FILE = "entitlements.json";

export interface Entitlements {
  storyId: string;
  entitled: { readerId: string }[];
}

export function isEntitlements(value: unknown): value is Entitlements {
  if (!value || typeof value !== "object") return false;
  const doc = value as Record<string, unknown>;
  if (typeof doc.storyId !== "string" || doc.storyId.length === 0) return false;
  if (!Array.isArray(doc.entitled) || doc.entitled.length === 0) return false;
  const seen = new Set<string>();
  for (const entry of doc.entitled) {
    if (!entry || typeof entry !== "object") return false;
    const readerId = (entry as Record<string, unknown>).readerId;
    if (!isSafeReaderId(readerId) || seen.has(readerId)) return false;
    seen.add(readerId);
  }
  return true;
}

// Every filename a package may legitimately carry. Used only to keep public
// skip reasons specific (never raw storage errors); required-ness is decided
// by the read/verify path, not this list.
const KNOWN_PACKAGE_FILES: readonly string[] = [...HISTORY_FILES, ENTITLEMENTS_FILE];

function collectHistoryProblems(parsed: Record<string, unknown>): string[] {
  const problems: string[] = [];
  const manifest = parsed["manifest.json"] as
    | { objects?: unknown; signing?: unknown; packageId?: unknown }
    | undefined;
  const signature = parsed["signature.json"] as { signedManifestSha256?: unknown } | undefined;
  if (manifest && Array.isArray(manifest.objects)) {
    const names = (manifest.objects as { path?: unknown }[]).map((o) => o?.path);
    for (const required of ["kinfolk.json", "story.json"]) {
      if (names.filter((name) => name === required).length !== 1) {
        problems.push(`manifest must list ${required} exactly once`);
      }
    }
    for (const obj of manifest.objects as { path?: unknown; sha256?: unknown }[]) {
      if (typeof obj?.path !== "string" || typeof obj?.sha256 !== "string") {
        problems.push("manifest has malformed object entry");
        continue;
      }
      const content = parsed[obj.path];
      if (content === undefined) {
        problems.push(`manifest lists ${obj.path} but it is missing`);
        continue;
      }
      if (hashObject(content) !== obj.sha256) problems.push(`hash mismatch: ${obj.path}`);
    }
  } else if (parsed["manifest.json"] !== undefined) {
    problems.push("manifest is malformed: objects is not an array");
  }
  if (manifest && signature) {
    if (typeof signature.signedManifestSha256 !== "string") {
      problems.push("signature is malformed: signedManifestSha256 is not a string");
    } else if (signature.signedManifestSha256 !== hashObject(manifest)) {
      problems.push("signature does not match manifest");
    } else if ((manifest as { signing?: string }).signing !== "ed25519") {
      // Legacy demo-placeholder envelopes are readable files, never trust.
      problems.push("package is not Ed25519 signed");
    } else if (!verifyManifestSignature(manifest, signature, parsed["kinfolk.json"])) {
      problems.push("Ed25519 signature verification failed");
    }
  }
  const kinfolk = parsed["kinfolk.json"] as { id?: unknown } | undefined;
  const story = parsed["story.json"] as { authorId?: unknown; id?: unknown } | undefined;
  if (kinfolk && story && (typeof kinfolk.id !== "string" || story.authorId !== kinfolk.id)) {
    problems.push("story author does not match Kinfolk identity");
  }
  if (!manifest || !signature || !kinfolk || !story) problems.push("incomplete package");
  return problems;
}

// M13 #94: a pinned contact's porch served a package signed by another key.
export const SIGNER_MISMATCH = "signer does not match followed creator";

function signerMatches(pkg: VerifiedHistoryPackage, pin: string): boolean {
  try {
    return identityFingerprint(pkg.kinfolk.publicKey ?? "") === pin;
  } catch {
    return false;
  }
}

export function toPublicSkipReason(rawReason: string): string {
  // Public timeline shape must not leak raw file/storage errors (OS messages,
  // errno, local absolute paths). Map each "; "-separated problem to a stable,
  // path-free token; unknown internals collapse to "unverified package".
  const withoutIdPrefix = rawReason.includes(": ")
    ? rawReason.slice(rawReason.indexOf(": ") + 2)
    : rawReason;
  const parts = withoutIdPrefix.split("; ").map((p) => p.trim()).filter(Boolean);
  const mapped = parts.map((part) => {
    const fileMatch = part.match(/^(missing unreadable file|invalid JSON):\s*([A-Za-z0-9._-]+)/);
    if (fileMatch) {
      const kind = fileMatch[1] === "missing unreadable file" ? "unreadable file" : "invalid JSON";
      const name = fileMatch[2];
      if (KNOWN_PACKAGE_FILES.includes(name)) return `${kind}: ${name}`;
      return kind;
    }
    if (part.includes(SIGNER_MISMATCH)) return SIGNER_MISMATCH;
    if (part.includes("package id mismatch")) return "package id mismatch";
    if (part.includes("hash mismatch")) {
      const m = part.match(/hash mismatch:\s*([A-Za-z0-9._-]+)/);
      if (m && (KNOWN_PACKAGE_FILES as readonly string[]).includes(m[1])) return `hash mismatch: ${m[1]}`;
      return "hash mismatch";
    }
    if (part.includes("signature does not match manifest")) return "signature does not match manifest";
    if (part.includes("Ed25519 signature verification failed")) return "signature verification failed";
    if (part.includes("not Ed25519 signed")) return "not Ed25519 signed";
    if (part.includes("signature is malformed")) return "invalid signature";
    if (part.includes("entitlements")) return "invalid entitlements";
    if (part.includes("manifest")) return "invalid manifest";
    if (part.includes("story author does not match")) return "author mismatch";
    if (part.includes("incomplete package")) return "incomplete package";
    if (part.includes("malformed story fields")) return "malformed story fields";
    if (part.includes("unsafe story id")) return "unsafe id";
    return "unverified package";
  });
  const deduped = [...new Set(mapped)];
  return deduped.length ? deduped.join("; ") : "unverified package";
}

export interface VerifiedHistoryPackage {
  kinfolk: Kinfolk;
  story: Story;
  manifest: Record<string, unknown> & { packageId: string };
  signature: Record<string, unknown>;
  entitlements?: Entitlements;
}

// Verify one historical story package before display. Rejects missing or
// tampered signatures and legacy demo-placeholder downgrades.
export async function fetchVerifiedHistoryPackage(store: ObjectStore, id: string): Promise<VerifiedHistoryPackage> {
  if (!isSafeHistoryId(id)) throw new Error(`${id}: unsafe story id`);
  const parsed: Record<string, unknown> = {};
  const problems: string[] = [];
  for (const f of HISTORY_FILES) {
    let text: string;
    try {
      text = new TextDecoder().decode(await store.readObject(`timeline/${id}/${f}`));
    } catch (e) {
      problems.push(`missing unreadable file: ${f} (${(e as Error).message})`);
      continue;
    }
    try {
      parsed[f] = JSON.parse(text);
    } catch {
      problems.push(`invalid JSON: ${f}`);
    }
  }
  // Optional slice-3 sidecar: read before collectHistoryProblems so the
  // generic manifest hash loop covers it (tampering fails closed). Read
  // errors stay collected problems, never raw throws; absence is fine here
  // (gated packages must carry it, checked below).
  try {
    const entitlementsText = new TextDecoder().decode(await store.readObject(`timeline/${id}/${ENTITLEMENTS_FILE}`));
    try {
      parsed[ENTITLEMENTS_FILE] = JSON.parse(entitlementsText);
    } catch {
      problems.push(`invalid JSON: ${ENTITLEMENTS_FILE}`);
    }
  } catch {
    // No sidecar on disk.
  }
  problems.push(...collectHistoryProblems(parsed));
  const storyDoc = parsed["story.json"] as { body?: unknown; restricted?: unknown } | undefined;
  if (storyDoc && storyDoc.restricted !== undefined) {
    if (!isSealedBody(storyDoc.restricted)) problems.push("gated envelope is malformed");
    else if (storyDoc.body !== "") problems.push("gated package contains plaintext body");
    else {
      const media = (storyDoc as { media?: unknown }).media;
      if (!Array.isArray(media) || media.length !== 0) problems.push("gated package contains plaintext media");
    }
  }
  // Entitlements binding (slice 3): gated packages must list the sidecar in
  // the manifest exactly once (hash-checked by the generic manifest loop
  // above, so tampering fails closed), carry a well-formed file whose
  // storyId matches the package, and public packages must carry none.
  const manifestDoc = parsed["manifest.json"] as { objects?: unknown } | undefined;
  const entitlementsListed = Array.isArray(manifestDoc?.objects)
    ? (manifestDoc.objects as { path?: unknown }[]).filter((o) => o?.path === ENTITLEMENTS_FILE).length
    : 0;
  const entitlementsDoc = parsed[ENTITLEMENTS_FILE] as Entitlements | undefined;
  if (storyDoc && storyDoc.restricted !== undefined) {
    if (entitlementsListed !== 1) problems.push(`manifest must list ${ENTITLEMENTS_FILE} exactly once`);
    if (entitlementsDoc === undefined) {
      problems.push(`gated package is missing ${ENTITLEMENTS_FILE}`);
    } else if (!isEntitlements(entitlementsDoc)) {
      problems.push("entitlements is malformed");
    } else if (entitlementsDoc.storyId !== id) {
      problems.push(`entitlements story mismatch: entitlements "${entitlementsDoc.storyId}" does not match package "${id}"`);
    }
  } else if (storyDoc && storyDoc.restricted === undefined) {
    if (entitlementsListed !== 0 || entitlementsDoc !== undefined) {
      problems.push(`public package must not contain ${ENTITLEMENTS_FILE}`);
    }
  }
  // M4 entitled-vs-wrapped cross-check (fail closed): for gated packages with
  // a well-formed sidecar + envelope, entitled[].readerId set must equal
  // restricted.wrapped[].readerId set. Divergence is a collected problem
  // (never a raw throw); public packages are unaffected.
  if (
    storyDoc &&
    storyDoc.restricted !== undefined &&
    entitlementsDoc !== undefined &&
    isEntitlements(entitlementsDoc) &&
    entitlementsDoc.storyId === id &&
    isSealedBody(storyDoc.restricted)
  ) {
    const entitledIds = entitlementsDoc.entitled.map((e) => e.readerId);
    const wrappedIds = (storyDoc.restricted as { wrapped: { readerId: string }[] }).wrapped.map((w) => w.readerId);
    const entitledSet = new Set(entitledIds);
    const wrappedSet = new Set(wrappedIds);
    const sameSize =
      entitledSet.size === entitledIds.length &&
      wrappedSet.size === wrappedIds.length &&
      entitledSet.size === wrappedSet.size;
    const sameMembers = [...entitledSet].every((rid) => wrappedSet.has(rid));
    if (!sameSize || !sameMembers) problems.push("entitlements/wrapped mismatch");
  }
  // Directory/story/manifest binding: a valid signed package copied under a
  // different timeline/<id>/ directory must not verify. The enumerated (or
  // requested) directory id, signed story.id, and signed manifest.packageId
  // must all agree before the package is accepted.
  const signedStoryId = (parsed["story.json"] as { id?: unknown } | undefined)?.id;
  const signedPackageId = (parsed["manifest.json"] as { packageId?: unknown } | undefined)?.packageId;
  if (signedStoryId !== id || signedPackageId !== id) {
    problems.push(
      `package id mismatch: directory "${id}" vs story "${String(signedStoryId)}" vs manifest "${String(signedPackageId)}"`
    );
  }
  if (problems.length) throw new Error(`${id}: ${problems.join("; ")}`);
  return {
    kinfolk: parsed["kinfolk.json"] as Kinfolk,
    story: parsed["story.json"] as Story,
    manifest: parsed["manifest.json"] as VerifiedHistoryPackage["manifest"],
    signature: parsed["signature.json"] as Record<string, unknown>,
    ...(entitlementsDoc !== undefined ? { entitlements: entitlementsDoc as Entitlements } : {}),
  };
}

export function tryOpenStory(story: Story, readerPrivateKey?: string, readerId?: string) {
  return tryOpenBody(story, readerPrivateKey, readerId);
}

export async function readVerifiedHistoryStory(store: ObjectStore, id: string): Promise<Story> {
  return (await fetchVerifiedHistoryPackage(store, id)).story;
}

export async function rebuildIndex(store: ObjectStore, label: string): Promise<TimelineEntry[]> {
  return (await readAuthenticatedTimeline(store, label, new Date().toISOString())).index.stories;
}

// Authenticated timeline read: timeline.json is an untrusted cache hint and
// is never used for display. Entries derive solely from verified history
// packages; tampered, unsigned, or legacy-placeholder entries are skipped.
export async function readAuthenticatedTimeline(
  store: ObjectStore, label: string, now: string, pin?: string,
): Promise<{ index: TimelineIndex; skipped: { id: string; reason: string }[] }> {
  const entries: TimelineEntry[] = [];
  const skipped: { id: string; reason: string }[] = [];
  let paths: string[] = [];
  try {
    paths = await store.listObjects("timeline/");
  } catch {
    return { index: { protocol: "rooted/v0.1", kind: "timeline", updatedAt: now, stories: entries, skipped }, skipped };
  }
  const ids = [...new Set(
    paths.map((p) => p.split("/")[1]).filter((id) => typeof id === "string" && id.length > 0)
  )];
  for (const id of ids) {
    try {
      const pkg = await fetchVerifiedHistoryPackage(store, id);
      if (pin !== undefined && !signerMatches(pkg, pin)) {
        skipped.push({ id, reason: `${id}: ${SIGNER_MISMATCH}` });
        continue;
      }
      const story = pkg.story as Partial<Story>;
      if (typeof story?.id === "string" && typeof story?.title === "string" &&
          typeof story?.authorId === "string" && typeof story?.createdAt === "string" &&
          !Number.isNaN(Date.parse(story.createdAt))) {
        // Directory, story, and manifest ids already agree (enforced in
        // fetchVerifiedHistoryPackage); the directory id is authoritative.
        entries.push({ id, title: story.title, authorId: story.authorId, createdAt: story.createdAt, verified: true });
      } else {
        skipped.push({ id, reason: "verified package has malformed story fields" });
      }
    } catch (e) {
      // Unverified history entry: skip, never fail the whole read.
      // Internal diagnostics keep raw detail; the public index below is sanitized.
      skipped.push({ id, reason: (e as Error).message });
    }
  }
  sortTimeline(entries);
  if (skipped.length > 0) {
    console.log(`rebuilt ${label} index from ${entries.length} verified on-disk ${entries.length === 1 ? "story" : "stories"} (${skipped.length} unverified skipped)`);
  } else if (entries.length > 0) {
    console.log(`rebuilt ${label} index from ${entries.length} on-disk ${entries.length === 1 ? "story" : "stories"}`);
  }
  // Public shape: never return raw file/storage errors (OS messages, errno,
  // local absolute paths). Internal `skipped` keeps full diagnostics.
  const publicSkipped = skipped.map((s) => ({ id: s.id, reason: toPublicSkipReason(s.reason) }));
  return { index: { protocol: "rooted/v0.1", kind: "timeline", updatedAt: now, stories: entries, skipped: publicSkipped }, skipped };
}

export interface FollowedPorch {
  label: string;
  store: ObjectStore;
  // M13 #94: only packages signed by this key fingerprint are accepted.
  pin?: string;
}

// Follow-model broadcast (M10 demo): pull one timeline across your porch
// plus every followed porch. Each porch is verified independently through
// the existing fail-closed path, so a tampered followed porch loses its
// own entries but never breaks the rest. Entries carry their origin porch;
// same id on two porches keeps the first porch listed. Sealed posts stay
// sealed — opening is still the #66 reader path per entry.
export function isPorchLabel(label: unknown): label is string {
  // Labels land in display entries and diagnostics, so they are gated at
  // the merge boundary: short, no slashes, no whitespace, no markup.
  return (
    typeof label === "string" &&
    label.length >= 1 &&
    label.length <= 32 &&
    /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(label)
  );
}

export async function readFollowedTimelines(
  porches: FollowedPorch[], now: string,
): Promise<{ stories: TimelineEntry[]; skipped: { porch: string; id: string; reason: string }[] }> {
  const seen = new Set<string>();
  const stories: TimelineEntry[] = [];
  const skipped: { porch: string; id: string; reason: string }[] = [];
  // Trust order = list order: the caller's own porch belongs first, and a
  // same-id entry on a later porch never shadows it, including when the
  // first porch has the id but failed verification. Porch ids are
  // author-chosen (not content-bound), so cross-porch id squats resolve
  // deterministically to the first-listed porch — callers must list their
  // own porch first and treat later duplicates as untrusted.
  for (const porch of porches) {
    if (!isPorchLabel(porch.label)) throw new Error("bad porch label");
    let read;
    try {
      // readAuthenticatedTimeline treats an unlistable store as empty (a
      // missing local folder). A remote porch that is down must show as
      // unreadable instead, so list first. Local listing never throws.
      await porch.store.listObjects("timeline/");
      read = await readAuthenticatedTimeline(porch.store, porch.label, now, porch.pin);
    } catch {
      // One broken porch (store fault, unexpected throw) loses its own
      // entries but never the whole merged read.
      skipped.push({ porch: porch.label, id: "*", reason: "porch unreadable" });
      continue;
    }
    for (const entry of read.index.stories) {
      if (seen.has(entry.id)) continue;
      seen.add(entry.id);
      stories.push({ ...entry, origin: porch.label });
    }
    for (const s of read.index.skipped ?? []) {
      skipped.push({ porch: porch.label, id: s.id, reason: s.reason });
      // An unverified package still owns its id. A later porch must not
      // fill that hole with a same-id squat.
      if (s.id !== "*") seen.add(s.id);
    }
  }
  sortTimeline(stories);
  return { stories, skipped };
}

// M10 #76: pull followed porches named by the contact address book.
// local: addresses resolve under storesRoot and must stay inside it
// (lexical containment, then realpath; a symlink that escapes is skipped).
// M11 #90: https: contacts are fetched read-only through HttpsPorchStore
// and verified the same way; an unreachable one is "porch unreadable".
// Origin is the own backend label, or the contact id when that id is a
// porch label. Trust order is own porch first, then contacts list order.
// A porch that already has an id owns it even if unverified, so a later
// squat cannot fall through on story open.
const FOLLOW_SKIP_REMOTE = "remote porch refused";
const FOLLOW_SKIP_ADDRESS = "bad porch address";
const FOLLOW_SKIP_LABEL = "bad porch label";

function safePorchName(id: string): string {
  return isPorchLabel(id) ? id : "contact";
}

type PorchLocate = { kind: "ok"; path: string } | { kind: "missing" } | { kind: "bad" };

function outsideRoot(root: string, target: string): boolean {
  const from = relative(root, target);
  return from.startsWith("..") || from.includes("../");
}

// Never return a path that has not been realpath-checked. A missing final
// component must not hide an ancestor symlink that leaves the root: that
// unresolved path would be followed on the later read.
async function locatePorch(storesRoot: string, rel: string): Promise<PorchLocate> {
  if (!rel || rel.startsWith("/") || rel.includes("\\") || rel.includes("\0")) return { kind: "bad" };
  const parts = rel.split("/");
  if (parts.some((part) => part === "" || part === "." || part === "..")) return { kind: "bad" };
  let realRoot: string;
  try {
    realRoot = await realpath(resolve(storesRoot));
  } catch {
    return { kind: "bad" };
  }
  let cursor = realRoot;
  for (const part of parts) {
    const next = resolve(cursor, part);
    let st;
    try {
      st = await lstat(next);
    } catch {
      return { kind: "missing" };
    }
    if (st.isSymbolicLink()) {
      let real: string;
      try {
        real = await realpath(next);
      } catch {
        return { kind: "bad" };
      }
      if (outsideRoot(realRoot, real)) return { kind: "bad" };
      cursor = real;
      continue;
    }
    if (!st.isDirectory() || outsideRoot(realRoot, next)) return { kind: "bad" };
    cursor = next;
  }
  return { kind: "ok", path: cursor };
}

interface ResolvedPorch {
  label: string;
  store: ObjectStore;
  path: string;
  pin?: string;
  invite?: string;
}

export interface FollowOptions {
  // Test seam for remote porches; production uses the global fetch.
  fetch?: (input: string, init?: RequestInit) => Promise<Response>;
}

async function resolveContactPorches(
  storesRoot: string,
  ownLabel: string,
  contactsLabel: string,
  opts: FollowOptions = {},
): Promise<{ porches: ResolvedPorch[]; skipped: { porch: string; id: string; reason: string }[]; contactsStore: ObjectStore | null }> {
  if (!isPorchLabel(ownLabel) || !isPorchLabel(contactsLabel)) throw new Error("bad porch label");
  const ownLoc = await locatePorch(storesRoot, ownLabel);
  const contactsLoc = await locatePorch(storesRoot, contactsLabel);
  if (ownLoc.kind === "bad" || contactsLoc.kind === "bad") throw new Error("bad porch label");
  const skipped: { porch: string; id: string; reason: string }[] = [];
  const porches: ResolvedPorch[] = [];
  const seen = new Set<string>();
  if (ownLoc.kind === "ok") {
    porches.push({ label: ownLabel, store: new LocalFolderStore(ownLoc.path), path: ownLoc.path });
    seen.add(ownLoc.path);
  }
  const contactsStore = contactsLoc.kind === "ok"
    ? (ownLoc.kind === "ok" && contactsLoc.path === ownLoc.path
      ? porches[0].store
      : new LocalFolderStore(contactsLoc.path))
    : null;
  const contacts = contactsStore ? await readContacts(contactsStore) : { contacts: [] as Contact[] };
  for (const contact of contacts.contacts) {
    const address = contact.address?.trim() ?? "";
    if (!address) continue;
    const porch = safePorchName(contact.id);
    if (address.startsWith("https://")) {
      if (!isPorchAddress(address) || !isPorchLabel(contact.id)) {
        skipped.push({ porch, id: "*", reason: isPorchAddress(address) ? FOLLOW_SKIP_LABEL : FOLLOW_SKIP_ADDRESS });
        continue;
      }
      let store: HttpsPorchStore;
      try {
        store = new HttpsPorchStore(address, { fetch: opts.fetch });
      } catch {
        skipped.push({ porch, id: "*", reason: FOLLOW_SKIP_REMOTE });
        continue;
      }
      const key = `remote:${address.replace(/\/+$/, "")}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const pinned: ResolvedPorch = { label: contact.id, store, path: key };
      if (isFingerprint(contact.fingerprint)) pinned.pin = contact.fingerprint;
      if (contact.invite) pinned.invite = contact.invite;
      porches.push(pinned);
      continue;
    }
    if (!address.startsWith("local:") || !isPorchAddress(address)) {
      skipped.push({ porch, id: "*", reason: FOLLOW_SKIP_ADDRESS });
      continue;
    }
    const rel = address.slice("local:".length);
    const porchLoc = await locatePorch(storesRoot, rel);
    if (porchLoc.kind !== "ok") {
      skipped.push({ porch, id: "*", reason: FOLLOW_SKIP_ADDRESS });
      continue;
    }
    if (seen.has(porchLoc.path)) continue;
    if (!isPorchLabel(contact.id)) {
      skipped.push({ porch, id: "*", reason: FOLLOW_SKIP_LABEL });
      continue;
    }
    seen.add(porchLoc.path);
    const local: ResolvedPorch = { label: contact.id, store: new LocalFolderStore(porchLoc.path), path: porchLoc.path };
    if (isFingerprint(contact.fingerprint)) local.pin = contact.fingerprint;
    porches.push(local);
  }
  return { porches, skipped, contactsStore };
}

// M13 #94: a pinned porch that is unreadable, or that serves nothing signed
// by the pinned key, may have moved. Re-resolve its invite (same M12 rules:
// same-origin porch with a verified post by the pinned key). A new address
// replaces the store for this read and is saved best-effort. The contact id,
// fingerprint and invite are unchanged, so there is no second follow.
async function followMovedPorches(
  porches: ResolvedPorch[],
  merged: { stories: TimelineEntry[]; skipped: { porch: string; id: string; reason: string }[] },
  contactsStore: ObjectStore | null,
  opts: FollowOptions,
): Promise<boolean> {
  let moved = false;
  for (const porch of porches) {
    if (!porch.pin || !porch.invite) continue;
    const unreadable = merged.skipped.some((s) => s.porch === porch.label && s.reason === "porch unreadable");
    const mismatched = !merged.stories.some((s) => s.origin === porch.label) &&
      merged.skipped.some((s) => s.porch === porch.label && s.reason === SIGNER_MISMATCH);
    if (!unreadable && !mismatched) continue;
    let fresh: Contact;
    try {
      fresh = await resolveInvite(porch.invite, opts);
    } catch {
      continue;
    }
    if (fresh.fingerprint !== porch.pin || !fresh.address) continue;
    const key = `remote:${fresh.address}`;
    if (key === porch.path) continue;
    porch.store = new HttpsPorchStore(fresh.address, { fetch: opts.fetch });
    porch.path = key;
    moved = true;
    if (contactsStore) {
      try {
        await updateContactAddress(contactsStore, porch.label, porch.pin, fresh.address);
      } catch {
        // Best effort: the next read re-resolves again.
      }
    }
  }
  return moved;
}

export async function readContactFollowedTimeline(
  storesRoot: string,
  ownLabel: string,
  now: string,
  contactsLabel: string = ownLabel,
  opts: FollowOptions = {},
): Promise<{ stories: TimelineEntry[]; skipped: { porch: string; id: string; reason: string }[] }> {
  const { porches, skipped, contactsStore } = await resolveContactPorches(storesRoot, ownLabel, contactsLabel, opts);
  const toFollowed = () => porches.map((porch) => ({ label: porch.label, store: porch.store, pin: porch.pin }));
  let merged = await readFollowedTimelines(toFollowed(), now);
  if (await followMovedPorches(porches, merged, contactsStore, opts)) {
    merged = await readFollowedTimelines(toFollowed(), now);
  }
  return { stories: merged.stories, skipped: [...skipped, ...merged.skipped] };
}

export async function readVerifiedFollowedStory(
  storesRoot: string,
  ownLabel: string,
  id: string,
  contactsLabel: string = ownLabel,
  opts: FollowOptions = {},
): Promise<Story> {
  if (!isSafeHistoryId(id)) throw new Error("not found");
  const { porches } = await resolveContactPorches(storesRoot, ownLabel, contactsLabel, opts);
  for (const porch of porches) {
    // Any file under the id owns it, even with no manifest, so a squat
    // cannot fall through when the first porch is only partly present.
    // An unreachable remote porch is skipped, as in the timeline merge.
    let listed: string[];
    try {
      listed = await porch.store.listObjects("timeline/");
    } catch {
      continue;
    }
    const prefix = `timeline/${id}`;
    const owns = listed.some((p) => p === prefix || p.startsWith(prefix + "/"));
    if (!owns) continue;
    const pkg = await fetchVerifiedHistoryPackage(porch.store, id);
    // The owning porch keeps the id even on a signer mismatch: no fall-through.
    if (porch.pin && !signerMatches(pkg, porch.pin)) throw new Error("not found");
    return pkg.story;
  }
  throw new Error("not found");
}

export async function readIndex(store: ObjectStore, label: string, now: string): Promise<TimelineIndex> {
  // Authenticated: derive display metadata from verified history packages
  // rather than trusting unsigned timeline.json values.
  return (await readAuthenticatedTimeline(store, label, now)).index;
}

export interface EntitleReader {
  readerId: string;
  readerPublicKey: string;
}

export function buildPackage(input: { title: string; body: string; media?: string[]; authorId: string; authorName: string; authorBio?: string; createdAt: string; storyId: string }, opts: { entitle?: EntitleReader; entitleReaders?: EntitleReader[] } = {}) {
  const identity = loadOrCreateIdentity(input.authorId);
  const kinfolk: Kinfolk = { id: input.authorId, displayName: input.authorName, publicKey: identity.publicKey };
  // M15 #100: the seed publisher signs the bio the invite panel shows.
  if (input.authorBio) kinfolk.bio = input.authorBio;
  const story: Story = {
    id: input.storyId,
    title: input.title,
    body: input.body,
    media: [],
    authorId: kinfolk.id,
    createdAt: input.createdAt,
  };
  const readers: EntitleReader[] = [...(opts.entitleReaders ?? []), ...(opts.entitle ? [opts.entitle] : [])];
  // M4 cross-check + Slice-3 sidecar (ids only, no keys/secrets). Signed via
  // the manifest like kinfolk/story so readers can discover entitlement
  // without trial-decrypt. Combine legacy `entitle` + batch `entitleReaders`
  // by readerId; duplicates fail fast so we never build an unverifiable pack.
  let entitlements: Entitlements | undefined;
  if (readers.length > 0) {
    const seenReaderIds = new Set<string>();
    for (const r of readers) {
      if (!isSafeReaderId(r.readerId)) throw new Error("entitle reader id contains unsafe characters");
      if (seenReaderIds.has(r.readerId)) throw new Error(`duplicate reader id: ${r.readerId}`);
      seenReaderIds.add(r.readerId);
    }
    story.body = "";
    story.media = [];
    story.restricted = sealGatedContent(input.body, input.media ?? [], readers);
    // Emit entitled[] exactly matching the sealed envelope wrapped[]
    // readerIds, same order (derived from the envelope itself).
    const sealed = story.restricted as { wrapped: { readerId: string }[] };
    entitlements = { storyId: input.storyId, entitled: sealed.wrapped.map((w) => ({ readerId: w.readerId })) };
  }
  const manifest = createManifest(input.storyId, [
    { path: "kinfolk.json", contentType: "application/json", value: kinfolk },
    { path: "story.json", contentType: "application/json", value: story },
    ...(entitlements
      ? [{ path: ENTITLEMENTS_FILE, contentType: "application/json", value: entitlements }]
      : []),
  ], "ed25519");
  const signature = signManifest(manifest, identity.privateKey);
  const files: Record<string, Uint8Array> = {
    "kinfolk.json": objectBytes(kinfolk),
    "story.json": objectBytes(story),
    ...(entitlements ? { [ENTITLEMENTS_FILE]: objectBytes(entitlements) } : {}),
    "manifest.json": objectBytes(manifest),
    "signature.json": objectBytes(signature),
  };
  return { kinfolk, story, manifest, signature, files, ...(entitlements ? { entitlements } : {}) };
}

export function makeStoryId(now: string): string {
  return `story-${now.slice(0, 10)}-${randomBytes(4).toString("hex")}`;
}

async function publishToTimeline(
  label: string,
  store: ObjectStore,
  storyId: string,
  story: Story,
  files: Record<string, Uint8Array>,
  now: string
): Promise<void> {
  const index = await readIndex(store, label, now);
  if (!index.stories.some((s) => s.id === storyId)) {
    index.stories.push({ id: storyId, title: story.title, authorId: story.authorId, createdAt: now, verified: true });
  }
  sortTimeline(index.stories);
  index.updatedAt = now;
  const indexBytes = new TextEncoder().encode(`${JSON.stringify(index)}\n`);
  // History first, then flat latest copy, then the index last: a crash can
  // only leave the index behind the data, never ahead of it.
  for (const [name, bytes] of Object.entries(files)) {
    await store.writeObject(`timeline/${storyId}/${name}`, bytes);
  }
  for (const [name, bytes] of Object.entries(files)) {
    await store.writeObject(name, bytes);
  }
  // M4 flat-copy lifecycle: public packages carry no sidecar, so a later
  // PUBLIC post must clear any stale flat entitlements.json left by an
  // earlier gated post. History (timeline/<id>/) is untouched; verification
  // only reads history.
  if (!(ENTITLEMENTS_FILE in files)) {
    await store.deleteObject(ENTITLEMENTS_FILE);
  }
  await store.writeObject("timeline.json", indexBytes);
  console.log(`posted ${storyId} to ${label} (timeline + latest)`);
}

export interface BackendSet {
  root: string;
  kevcloud?: { baseUrl: string; username: string; password: string };
  drive?: { remote: string; folder: string };
}

export function backendsFromEnv(repoRoot: string): BackendSet {
  const root = process.env.PUBLISH_ROOT
    ? resolve(process.env.PUBLISH_ROOT)
    : resolve(repoRoot, "demo/stores");
  const out: BackendSet = { root };
  if (process.env.KEVCLOUD_WEBDAV_URL && process.env.KEVCLOUD_WEBDAV_USER && process.env.KEVCLOUD_WEBDAV_PASS) {
    out.kevcloud = {
      baseUrl: process.env.KEVCLOUD_WEBDAV_URL,
      username: process.env.KEVCLOUD_WEBDAV_USER,
      password: process.env.KEVCLOUD_WEBDAV_PASS,
    };
  }
  if (process.env.GOOGLE_DRIVE_SYNC === "1") {
    out.drive = {
      remote: process.env.GOOGLE_DRIVE_REMOTE ?? "rooted_drive:",
      folder: process.env.GOOGLE_DRIVE_FOLDER ?? "Rooted OwnPlace Demo",
    };
  }
  return out;
}

/** Publish one validated story to its author's porch and that porch's cloud. */
export async function publishStory(
  validated: { title: string; body: string; media?: string[]; authorId: string; authorName: string; authorBio?: string },
  backends: BackendSet,
  opts: { createdAt?: string; storyId?: string; entitle?: EntitleReader; entitleReaders?: EntitleReader[]; membersOnly?: boolean } = {}
): Promise<PublishResult> {
  // M15 #100: one Kinfolk, one porch (and that porch's cloud only).
  const home = demoKinfolkFor(validated.authorId) ?? DEFAULT_PORCH;
  const now = opts.createdAt ?? new Date().toISOString();
  const storyId = opts.storyId ?? makeStoryId(now);
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(storyId)) throw new Error("unsafe story id");
  const entitleReaders = await mergeSubscriberReaders(backends, opts, validated.authorId, home.porch);
  const { files, story } = buildPackage({ ...validated, createdAt: now, storyId }, entitleReaders.length ? { entitleReaders } : {});
  const published: string[] = [];
  const skipped: string[] = [];

  const dir = resolve(backends.root, home.porch);
  await mkdir(dir, { recursive: true });
  await publishToTimeline(home.porch, new LocalFolderStore(dir), storyId, story, files, now);
  published.push(home.porch);

  if (home.cloud !== "kevcloud") {
    skipped.push("kevcloud");
  } else if (backends.kevcloud) {
    await publishToTimeline(
      "kevcloud (WebDAV)",
      new WebDavStore({ ...backends.kevcloud }),
      storyId, story, files, now
    );
    published.push("kevcloud");
  } else {
    skipped.push("kevcloud");
    console.log("skip kevcloud: KEVCLOUD_WEBDAV_URL/USER/PASS not set");
  }

  if (home.cloud !== "google-drive") {
    skipped.push("google-drive");
  } else if (backends.drive) {
    const src = resolve(backends.root, home.porch) + "/";
    await run("rclone", ["copy", src, `${backends.drive.remote}${backends.drive.folder}/`, "--timeout", "30s"],
      { timeout: 90000 });
    console.log(`posted ${storyId} to google-drive (rclone ${backends.drive.remote}${backends.drive.folder}/)`);
    published.push("google-drive");
  } else {
    skipped.push("google-drive");
    console.log("skip google-drive: GOOGLE_DRIVE_SYNC!=1");
  }

  return { storyId, authorId: validated.authorId, backends: published, skipped };
}

// --- Contacts (syndication address book) ---

const PORCH_ADDRESS_MAX = 200;

export function isPorchAddress(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const address = value.trim();
  if (address.length < 8 || address.length > PORCH_ADDRESS_MAX) return false;
  if (address.includes("\\") || address.includes("\0") || address.includes("..")) return false;
  if (address.startsWith("https://")) {
    if (address.includes("@") || address.includes(" ")) return false;
    return /^https:\/\/[A-Za-z0-9.-]+(?::\d{1,5})?(?:\/[A-Za-z0-9._~:/?#\[\]!$&'()*+,;=%-]*)?$/.test(address);
  }
  if (address.startsWith("local:")) {
    const rest = address.slice("local:".length);
    return /^[A-Za-z0-9][A-Za-z0-9._-]*(?:\/[A-Za-z0-9][A-Za-z0-9._-]*)*$/.test(rest);
  }
  return false;
}

export function validateContact(input: { id?: unknown; displayName?: unknown; address?: unknown }): Contact {
  if (typeof input?.id !== "string" || !input.id.trim()) throw new Error("contact id is required");
  if (typeof input?.displayName !== "string" || !input.displayName.trim()) {
    throw new Error("contact displayName is required");
  }
  const id = input.id.trim();
  // Origin tags on a merged timeline must be porch labels, so new follows
  // cannot use an id that the merge would have to drop.
  if (!isPorchLabel(id)) throw new Error("contact id contains unsafe characters");
  if (input.displayName.trim().length > 120) throw new Error("contact displayName too long");
  const address = typeof input.address === "string" ? input.address.trim() : "";
  if (!isPorchAddress(address)) throw new Error("contact address must be https or local: without traversal");
  return {
    id,
    displayName: input.displayName.trim(),
    addedAt: new Date().toISOString(),
    address,
  };
}

export async function readContacts(store: ObjectStore): Promise<ContactList> {
  try {
    const raw = new TextDecoder().decode(await store.readObject("contacts.json"));
    const parsed = JSON.parse(raw) as Partial<ContactList>;
    if (parsed && Array.isArray(parsed.contacts)) {
      const contacts = parsed.contacts.flatMap((c): Contact[] => {
        if (!c || typeof c.id !== "string" || typeof c.displayName !== "string") return [];
        const contact: Contact = {
          id: c.id,
          displayName: c.displayName,
          addedAt: typeof c.addedAt === "string" ? c.addedAt : new Date().toISOString(),
        };
        if (isPorchAddress(c.address)) contact.address = c.address.trim();
        if (isFingerprint(c.fingerprint)) contact.fingerprint = c.fingerprint;
        if (isInviteLink(c.invite)) contact.invite = c.invite;
        return [contact];
      });
      return {
        protocol: "rooted/v0.1",
        kind: "contacts",
        updatedAt: typeof parsed.updatedAt === "string" ? parsed.updatedAt : new Date().toISOString(),
        contacts,
      };
    }
  } catch {
    // missing/unreadable: empty list
  }
  return { protocol: "rooted/v0.1", kind: "contacts", updatedAt: new Date().toISOString(), contacts: [] };
}

export async function addContact(store: ObjectStore, contact: Contact): Promise<ContactList> {
  const list = await readContacts(store);
  const existing = list.contacts.find((c) => c.id === contact.id);
  if (existing) {
    existing.displayName = contact.displayName;
    if (contact.address) existing.address = contact.address;
    if (contact.fingerprint) existing.fingerprint = contact.fingerprint;
    if (contact.invite) existing.invite = contact.invite;
  } else {
    list.contacts.push(contact);
  }
  list.contacts.sort((a, b) => a.displayName.localeCompare(b.displayName));
  list.updatedAt = new Date().toISOString();
  await store.writeObject("contacts.json", new TextEncoder().encode(`${JSON.stringify(list)}\n`));
  return list;
}

// M13 #94: only moves a contact that still carries the same pinned key.
export async function updateContactAddress(store: ObjectStore, id: string, pin: string, address: string): Promise<boolean> {
  if (!isPorchAddress(address)) throw new Error("bad porch address");
  const list = await readContacts(store);
  const contact = list.contacts.find((c) => c.id === id && c.fingerprint === pin);
  if (!contact || contact.address === address) return false;
  contact.address = address;
  list.updatedAt = new Date().toISOString();
  await store.writeObject("contacts.json", new TextEncoder().encode(`${JSON.stringify(list)}\n`));
  return true;
}

export async function removeContact(store: ObjectStore, id: string): Promise<ContactList> {
  const list = await readContacts(store);
  list.contacts = list.contacts.filter((c) => c.id !== id);
  list.updatedAt = new Date().toISOString();
  await store.writeObject("contacts.json", new TextEncoder().encode(`${JSON.stringify(list)}\n`));
  return list;
}

export interface Subscriber {
  readerId: string;
  readerPublicKey: string;
  addedAt: string;
}
export interface SubscriberList {
  protocol: "rooted/v0.1";
  kind: "subscribers";
  updatedAt: string;
  subscribers: Subscriber[];
}

const SUBSCRIBERS_FILE = "subscribers.json";
const SUBSCRIBER_KEY_MAX = 8192;

export function validateSubscriber(input: { readerId?: unknown; readerPublicKey?: unknown }): Subscriber {
  if (!isSafeReaderId(input?.readerId)) throw new Error("subscriber readerId is unsafe");
  if (typeof input?.readerPublicKey !== "string") throw new Error("subscriber readerPublicKey is required");
  const readerPublicKey = input.readerPublicKey.trim();
  if (readerPublicKey.length < 32 || readerPublicKey.length > SUBSCRIBER_KEY_MAX) {
    throw new Error("subscriber readerPublicKey length is invalid");
  }
  if (!readerPublicKey.includes("BEGIN") || !readerPublicKey.includes("PUBLIC KEY")) {
    throw new Error("subscriber readerPublicKey must be a PEM public key");
  }
  return { readerId: input.readerId, readerPublicKey, addedAt: new Date().toISOString() };
}

export async function readSubscribers(store: ObjectStore): Promise<SubscriberList> {
  try {
    const raw = new TextDecoder().decode(await store.readObject(SUBSCRIBERS_FILE));
    const parsed = JSON.parse(raw) as Partial<SubscriberList>;
    if (parsed && Array.isArray(parsed.subscribers)) {
      const subscribers = parsed.subscribers.filter(
        (s): s is Subscriber =>
          isSafeReaderId(s?.readerId) && typeof s?.readerPublicKey === "string" && s.readerPublicKey.length > 0,
      );
      return {
        protocol: "rooted/v0.1",
        kind: "subscribers",
        updatedAt: typeof parsed.updatedAt === "string" ? parsed.updatedAt : new Date().toISOString(),
        subscribers,
      };
    }
  } catch {
    // missing/unreadable: empty list
  }
  return { protocol: "rooted/v0.1", kind: "subscribers", updatedAt: new Date().toISOString(), subscribers: [] };
}

export async function addSubscriber(store: ObjectStore, subscriber: Subscriber): Promise<SubscriberList> {
  const list = await readSubscribers(store);
  const existing = list.subscribers.find((s) => s.readerId === subscriber.readerId);
  if (existing) existing.readerPublicKey = subscriber.readerPublicKey;
  else list.subscribers.push(subscriber);
  list.subscribers.sort((a, b) => a.readerId.localeCompare(b.readerId));
  list.updatedAt = new Date().toISOString();
  await store.writeObject(SUBSCRIBERS_FILE, new TextEncoder().encode(`${JSON.stringify(list)}\n`));
  return list;
}

async function mergeSubscriberReaders(
  backends: BackendSet,
  opts: { entitle?: EntitleReader; entitleReaders?: EntitleReader[]; membersOnly?: boolean },
  authorId: string,
  porch: string,
): Promise<EntitleReader[]> {
  const readers: EntitleReader[] = [...(opts.entitleReaders ?? []), ...(opts.entitle ? [opts.entitle] : [])];
  const gated = opts.membersOnly === true || readers.length > 0;
  if (!gated) return [];
  const seen = new Set(readers.map((r) => r.readerId));
  if (opts.membersOnly === true && isSafeReaderId(authorId) && !seen.has(authorId)) {
    const enc = loadOrCreateEncryptionIdentity(authorId);
    seen.add(authorId);
    readers.push({ readerId: authorId, readerPublicKey: enc.publicKey });
  }
  // M15 #100: subscribers are read from the author's own porch.
  const store = new LocalFolderStore(resolve(backends.root, porch));
  const roster = await readSubscribers(store);
  for (const s of roster.subscribers) {
    if (seen.has(s.readerId)) continue;
    seen.add(s.readerId);
    readers.push({ readerId: s.readerId, readerPublicKey: s.readerPublicKey });
  }
  if (opts.membersOnly === true && readers.length === 0) {
    throw new Error("members-only post needs at least one subscriber or entitled reader");
  }
  return readers;
}


export function defaultRepoRoot(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
}

// --- Invitations (M12 #92) ---
// An invite names a creator by key fingerprint and says where their porch
// is, relative to the invite URL. It carries no storage paths or secrets.
// Nothing in the document is trusted by a follower: the fingerprint must
// match the signer of a verified package on that porch, and the display
// name is taken from that signed package.

export interface InviteDocument {
  protocol: "rooted/v0.1";
  kind: "invite";
  fingerprint: string;
  displayName: string;
  bio?: string;
  porch: string;
}

export const INVITE_PATH = /^\/i\/([0-9a-f]{64})$/;

export function isInviteLink(value: unknown): value is string {
  if (typeof value !== "string" || value.length > 400) return false;
  try {
    const url = new URL(value);
    const at = url.pathname.lastIndexOf("/i/");
    return url.protocol === "https:" && !url.search && !url.hash && !url.username && at >= 0 &&
      INVITE_PATH.test(url.pathname.slice(at));
  } catch {
    return false;
  }
}

export async function porchIdentity(store: ObjectStore): Promise<{ fingerprint: string; displayName: string; bio?: string } | null> {
  try {
    const kinfolk = JSON.parse(new TextDecoder().decode(await store.readObject("kinfolk.json"))) as Partial<Kinfolk>;
    if (typeof kinfolk.publicKey !== "string" || typeof kinfolk.displayName !== "string") return null;
    const out: { fingerprint: string; displayName: string; bio?: string } = {
      fingerprint: identityFingerprint(kinfolk.publicKey),
      displayName: kinfolk.displayName.slice(0, 120),
    };
    if (typeof kinfolk.bio === "string") out.bio = kinfolk.bio.slice(0, 500);
    return out;
  } catch {
    return null;
  }
}

export function buildInviteDocument(identity: { fingerprint: string; displayName: string; bio?: string }, backend: string): InviteDocument {
  if (!isPorchLabel(backend)) throw new Error("bad porch label");
  const doc: InviteDocument = {
    protocol: "rooted/v0.1",
    kind: "invite",
    fingerprint: identity.fingerprint,
    displayName: identity.displayName,
    porch: `../porch/${backend}`,
  };
  if (identity.bio) doc.bio = identity.bio;
  return doc;
}

export function inviteContactId(fingerprint: string): string {
  return `op-${fingerprint.slice(0, 12)}`;
}

// Resolve and verify an invite link, returning the contact to store.
// Fails closed on any mismatch; messages are public-safe (no raw errors).
export async function resolveInvite(inviteUrl: string, opts: FollowOptions = {}): Promise<Contact> {
  let url: URL;
  try {
    url = new URL(inviteUrl.trim());
  } catch {
    throw new Error("invite link is not a URL");
  }
  if (url.protocol !== "https:") throw new Error("invite link must be https");
  if (url.username || url.password || url.search || url.hash) throw new Error("invite link has extra parts");
  const path = url.pathname.replace(/\/+$/, "");
  const at = path.lastIndexOf("/i/");
  const match = at >= 0 ? INVITE_PATH.exec(path.slice(at)) : null;
  if (!match) throw new Error("not an OwnPlace invite link");
  const fingerprint = match[1];
  const baseUrl = `${url.origin}${path.slice(0, at)}`;
  let base: HttpsPorchStore;
  try {
    base = new HttpsPorchStore(baseUrl || url.origin, { fetch: opts.fetch });
  } catch {
    throw new Error("invite host refused");
  }
  let doc: Partial<InviteDocument>;
  try {
    doc = JSON.parse(new TextDecoder().decode(await base.readObject(`i/${fingerprint}.json`)));
  } catch {
    throw new Error("invite could not be loaded");
  }
  if (doc?.kind !== "invite" || doc.fingerprint !== fingerprint || typeof doc.porch !== "string") {
    throw new Error("invite document is malformed");
  }
  let porchUrl: URL;
  try {
    porchUrl = new URL(doc.porch, `${baseUrl}/i/${fingerprint}`);
  } catch {
    throw new Error("invite document is malformed");
  }
  // Same origin only: an invite cannot send followers to someone else's host.
  if (porchUrl.origin !== url.origin || porchUrl.search || porchUrl.hash) throw new Error("invite porch is on another host");
  const address = porchUrl.href.replace(/\/+$/, "");
  if (!isPorchAddress(address)) throw new Error("invite porch address is not allowed");
  const porch = new HttpsPorchStore(address, { fetch: opts.fetch });
  let ids: string[];
  try {
    ids = [...new Set((await porch.listObjects("timeline/")).map((p) => p.split("/")[1]))];
  } catch {
    throw new Error("invite porch could not be read");
  }
  for (const id of ids) {
    let pkg: VerifiedHistoryPackage;
    try {
      pkg = await fetchVerifiedHistoryPackage(porch, id);
    } catch {
      continue;
    }
    let signer: string;
    try {
      signer = identityFingerprint(pkg.kinfolk.publicKey ?? "");
    } catch {
      continue;
    }
    if (signer !== fingerprint) continue;
    const displayName = (pkg.kinfolk.displayName ?? "").trim().slice(0, 120) || inviteContactId(fingerprint);
    return {
      id: inviteContactId(fingerprint),
      displayName,
      addedAt: new Date().toISOString(),
      address,
      fingerprint,
      invite: `${baseUrl}/i/${fingerprint}`,
    };
  }
  throw new Error("invite porch has no verified post by this creator");
}
