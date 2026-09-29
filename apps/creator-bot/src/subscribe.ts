import { mkdir } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { LocalFolderStore } from "@rooted/storage";
import {
  addSubscriber,
  backendsFromEnv,
  defaultRepoRoot,
  demoKinfolkFor,
  NO_PORCH,
  OPERATOR_KINFOLK,
  requireOperatorSettings,
  validateSubscriber,
} from "@rooted/timeline";

function arg(name: string): string | undefined {
  const idx = process.argv.indexOf(`--${name}`);
  if (idx < 0) return undefined;
  const value = process.argv[idx + 1];
  if (value === undefined || value.startsWith("--")) return undefined;
  return value;
}

const USAGE = `usage: npm run subscribe -- --author-id ${OPERATOR_KINFOLK}|kinfolk-sam --reader-id ID --reader-pubkey FILE`;

function fail(message: string): never {
  console.error(`subscribe failed: ${message}`);
  console.error(USAGE);
  process.exit(2);
}

// M15 #111: invalid OWNPLACE_OPERATOR_* settings refuse startup.
requireOperatorSettings();

// M16 #108: a reader subscribes to one Kinfolk, so the roster is written to
// that Kinfolk's porch only. Unknown authors are refused before any write.
const authorId = arg("author-id");
if (!authorId) fail("need --author-id");
const kinfolk = demoKinfolkFor(authorId);
if (!kinfolk) fail(NO_PORCH);

const readerId = arg("reader-id");
const pubkeyFile = arg("reader-pubkey");
if (!readerId || !pubkeyFile) fail("need --reader-id and --reader-pubkey");

let publicKey: string;
try {
  publicKey = readFileSync(pubkeyFile, "utf8");
} catch {
  fail("cannot read --reader-pubkey file");
}

let subscriber;
try {
  subscriber = validateSubscriber({ readerId, readerPublicKey: publicKey });
} catch (e) {
  fail((e as Error).message);
}

const backends = backendsFromEnv(defaultRepoRoot());
const dir = resolve(backends.root, kinfolk.porch);
await mkdir(dir, { recursive: true });
await addSubscriber(new LocalFolderStore(dir), subscriber);
console.log(`done: subscribed ${subscriber.readerId} to ${kinfolk.id} on ${kinfolk.porch}`);
