// Thin CLI over @rooted/timeline: same lane the web write API uses.
// Slice-1 paid gating: --entitle-reader ID plus --reader-pubkey FILE seals the body for one reader; default posts stay public.
// Slice-3 paid gating: --entitle-readers JSONFILE seals for N readers at once (JSON array of
// {readerId, pubkeyFile} or {readerId, publicKey}); combines with the legacy single-reader flags.
// M15 #101: --reply-to STORY_ID comments on a post the author can see; --wall CONTACT_ID
// writes on a followed Kinfolk's wall. Both publish to the author's own porch, public only.
// M16 #116: posts are encrypted to the author and their mutual follows by default; --public
// writes the signed plaintext format instead.

import { readFileSync } from "node:fs";
import {
  defaultRepoRoot,
  backendsFromEnv,
  checkReplyTarget,
  commentTargetFor,
  demoKinfolkFor,
  NO_PORCH,
  OPERATOR_KINFOLK,
  porchReaderKey,
  publishStory,
  requireOperatorSettings,
  validateInput,
  wallTargetFor,
} from "@rooted/timeline";

function arg(name: string): string | undefined {
  const idx = process.argv.indexOf(`--${name}`);
  if (idx < 0) return undefined;
  const value = process.argv[idx + 1];
  if (value === undefined || value.startsWith("--")) return undefined;
  return value;
}

const USAGE = `usage: npm run post -- --title "TITLE" --body "BODY" [--author-id ${OPERATOR_KINFOLK}|kinfolk-sam] [--author-name NAME] [--reply-to STORY_ID | --wall CONTACT_ID] [--public] [--members-only] [--entitle-reader ID --reader-pubkey FILE] [--entitle-readers JSONFILE]`;

function fail(message: string): never {
  console.error(`post failed: ${message}`);
  console.error(USAGE);
  process.exit(2);
}

// M15 #113: refuse unknown flags and stray arguments before anything is read
// or signed, so a typo like --author can't silently post as the operator.
const VALUE_FLAGS = new Set(["title", "body", "author-id", "author-name", "reply-to", "wall", "entitle-reader", "reader-pubkey", "entitle-readers"]);
const BOOLEAN_FLAGS = new Set(["members-only", "public"]);

function checkArgs(argv: string[]): void {
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (!token.startsWith("--")) fail(`unexpected argument: ${token}`);
    const name = token.slice(2);
    if (BOOLEAN_FLAGS.has(name)) continue;
    if (!VALUE_FLAGS.has(name)) fail(`unknown flag: ${token}`);
    // A missing value (next token is a flag) is left to the per-flag checks below.
    if (argv[i + 1] !== undefined && !argv[i + 1].startsWith("--")) i++;
  }
}

checkArgs(process.argv.slice(2));

// M15 #111: invalid OWNPLACE_OPERATOR_* settings refuse startup.
requireOperatorSettings();

function isSafeId(id: unknown): id is string {
  return typeof id === "string" && /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(id) && !id.includes("..");
}

const backends = backendsFromEnv(defaultRepoRoot());
const replyTo = arg("reply-to");
const wall = arg("wall");
if (replyTo !== undefined && wall !== undefined) fail("a post is either a comment or a wall post, not both");

// M15 #101: targets resolve from the author's own porch: a comment's post
// must be in their threaded view, a wall's Kinfolk in their pinned contacts.
// Replies need no --title.
let target: { to?: Awaited<ReturnType<typeof wallTargetFor>>; inReplyTo?: Awaited<ReturnType<typeof commentTargetFor>> } = {};
if (replyTo !== undefined || wall !== undefined) {
  const author = demoKinfolkFor((arg("author-id") ?? OPERATOR_KINFOLK).trim());
  if (!author) fail(NO_PORCH);
  // M16 #116: the author reads their own view, so encrypted posts count.
  const readerKey = porchReaderKey(author.porch);
  try {
    target = replyTo !== undefined
      ? { inReplyTo: await commentTargetFor(backends.root, author.porch, replyTo, { readerKey }) }
      : { to: await wallTargetFor(backends.root, author.porch, wall!) };
    await checkReplyTarget(backends.root, author.porch, target, { readerKey });
  } catch (e) {
    fail((e as Error).message);
  }
}

let validated;
try {
  validated = validateInput({
    title: arg("title") ?? (target.to || target.inReplyTo ? undefined : ""),
    body: arg("body") ?? "",
    authorId: arg("author-id"),
    authorName: arg("author-name"),
    ...target,
  });
} catch (e) {
  console.error(`post failed: ${(e as Error).message}`);
  console.error(USAGE);
  process.exit(2);
}

// M15 #100: each demo Kinfolk posts to their own porch; there is no porch
// for any other author id, so the post is refused before signing.
if (!demoKinfolkFor(validated.authorId)) fail(NO_PORCH);

let entitle: { readerId: string; readerPublicKey: string } | undefined;
const entitleReader = arg("entitle-reader");
const readerPubkeyFile = arg("reader-pubkey");
if ((entitleReader === undefined) !== (readerPubkeyFile === undefined)) {
  console.error("post failed: --entitle-reader and --reader-pubkey must be used together");
  process.exit(2);
}
if (entitleReader !== undefined && readerPubkeyFile !== undefined) {
  if (!isSafeId(entitleReader)) {
    console.error("post failed: unsafe entitle-reader id");
    process.exit(2);
  }
  try {
    entitle = { readerId: entitleReader, readerPublicKey: readFileSync(readerPubkeyFile, "utf8") };
  } catch {
    console.error("post failed: cannot read --reader-pubkey file");
    process.exit(2);
  }
}

// Multi-reader batch file: non-empty JSON array of {readerId, pubkeyFile}
// (path to a PEM file) or {readerId, publicKey} (inline PEM). Combines with
// the legacy single-reader flags above; duplicate ids are misuse.
let entitleReaders: { readerId: string; readerPublicKey: string }[] | undefined;
const entitleReadersFile = arg("entitle-readers");
if (entitleReadersFile !== undefined) {
  let raw: string;
  try {
    raw = readFileSync(entitleReadersFile, "utf8");
  } catch {
    fail("cannot read --entitle-readers file");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    fail("invalid JSON in --entitle-readers file");
  }
  if (!Array.isArray(parsed) || parsed.length === 0) {
    fail("--entitle-readers file must contain a non-empty JSON array");
  }
  const seen = new Set<string>(entitle ? [entitle.readerId] : []);
  const batch: { readerId: string; readerPublicKey: string }[] = [];
  for (const entry of parsed) {
    if (!entry || typeof entry !== "object") {
      fail("--entitle-readers entries must be {readerId, pubkeyFile} or {readerId, publicKey}");
    }
    const { readerId, pubkeyFile, publicKey } = entry as Record<string, unknown>;
    if (!isSafeId(readerId)) fail("unsafe entitle-reader id in --entitle-readers file");
    if (seen.has(readerId)) fail(`duplicate entitle-reader id in --entitle-readers file: ${readerId}`);
    let key: string | undefined;
    if (typeof pubkeyFile === "string") {
      try {
        key = readFileSync(pubkeyFile, "utf8");
      } catch {
        fail(`cannot read pubkeyFile for reader ${readerId} in --entitle-readers file`);
      }
    } else if (typeof publicKey === "string" && publicKey.length > 0) {
      key = publicKey;
    } else {
      fail(`reader ${readerId} in --entitle-readers file needs pubkeyFile or publicKey`);
    }
    if (!key || !key.trim()) fail(`empty public key for reader ${readerId} in --entitle-readers file`);
    seen.add(readerId);
    batch.push({ readerId, readerPublicKey: key });
  }
  entitleReaders = batch;
}
const membersOnly = process.argv.includes("--members-only");
const isPublic = process.argv.includes("--public");
if ((validated.to || validated.inReplyTo) && (membersOnly || entitle || entitleReaders)) fail("comments and wall posts are public in this slice");
if (isPublic && (membersOnly || entitle || entitleReaders)) fail("--public cannot be combined with paid-gating flags");
const res = await publishStory(validated, backends, { entitle, entitleReaders, membersOnly, public: isPublic });
console.log(`done: ${res.backends.join(", ")} story=${res.storyId} author=${res.authorId}`);
