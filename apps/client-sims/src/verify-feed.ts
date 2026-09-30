import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { identityFingerprint } from "@rooted/protocol";
import { LocalFolderStore } from "@rooted/storage";
import {
  DEMO_KINFOLK,
  porchReaderKey,
  readAuthenticatedTimeline,
  readContactFollowedTimeline,
  readContacts,
  requireOperatorSettings,
  type DemoKinfolk,
} from "@rooted/timeline";
import { KinfolkClient } from "./client.js";

// Repo root resolved from this file, not cwd: `npm run verify` executes
// with cwd set to the workspace dir (apps/client-sims).
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

// M15 #100: per-porch verification replaces cross-backend parity. Each
// porch belongs to one Kinfolk and must verify on its own:
//   1. its latest package verifies (hashes + Ed25519) and is signed as its owner;
//   2. every timeline/ history package verifies and is signed by the owner's key;
//   3. it follows each other demo Kinfolk at their local: porch, pinned to
//      that Kinfolk's key, and the followed entries verify against that key.
// M16 #116: each porch is read as its owner, so encrypted posts must open
// with the owner's key (own posts) or as a mutual follow (followed posts).
// The two porches must hold two different keys: mirroring one person fails.
export interface PorchReport {
  porch: string;
  kinfolk: string;
  fingerprint?: string;
  own: number;
  followed: number;
  encrypted: number;
  problems: string[];
}

interface Identity { kinfolk: DemoKinfolk; fingerprint?: string }

async function porchIdentityOf(storesRoot: string, kinfolk: DemoKinfolk, problems: string[]): Promise<Identity> {
  try {
    const pkg = await new KinfolkClient(new LocalFolderStore(resolve(storesRoot, kinfolk.porch)), kinfolk.porch).fetchPackage();
    const signer = pkg.kinfolk as { id?: unknown; publicKey?: unknown };
    if (signer.id !== kinfolk.id) {
      problems.push(`latest package is not signed as ${kinfolk.id}`);
      return { kinfolk };
    }
    return { kinfolk, fingerprint: identityFingerprint(String(signer.publicKey)) };
  } catch (e) {
    problems.push((e as Error).message);
    return { kinfolk };
  }
}

async function verifyPorch(storesRoot: string, self: Identity, others: Identity[], problems: string[], now: string): Promise<{ own: number; followed: number; encrypted: number }> {
  const porch = self.kinfolk.porch;
  const store = new LocalFolderStore(resolve(storesRoot, porch));
  if (!self.fingerprint) return { own: 0, followed: 0, encrypted: 0 };
  const readerKey = porchReaderKey(porch);
  const history = await readAuthenticatedTimeline(store, porch, now, self.fingerprint, readerKey);
  for (const s of history.index.skipped ?? []) problems.push(`history ${s.id}: ${s.reason}`);
  const own = history.index.stories.length;
  if (own === 0) problems.push("no verified history signed by the porch owner");

  const contacts = (await readContacts(store)).contacts;
  const merged = await readContactFollowedTimeline(storesRoot, porch, now, porch, { readerKey });
  for (const s of merged.skipped) {
    if (s.porch !== porch) problems.push(`followed ${s.porch} ${s.id}: ${s.reason}`);
  }
  let followed = 0;
  for (const other of others) {
    const contact = contacts.find((c) => c.id === other.kinfolk.id);
    if (!contact) {
      problems.push(`does not follow ${other.kinfolk.id}`);
      continue;
    }
    if (contact.address !== `local:${other.kinfolk.porch}`) problems.push(`follows ${other.kinfolk.id} at the wrong address`);
    if (!other.fingerprint || contact.fingerprint !== other.fingerprint) problems.push(`follow of ${other.kinfolk.id} is not pinned to their key`);
    const entries = merged.stories.filter((s) => s.origin === other.kinfolk.id).length;
    if (entries === 0) problems.push(`no verified entries from ${other.kinfolk.id}`);
    followed += entries;
  }
  const encrypted = merged.stories.filter((s) => s.encrypted).length;
  return { own, followed, encrypted };
}

export async function verifyStores(storesRoot = resolve(repoRoot, "demo/stores"), now = new Date().toISOString()) {
  const problems: Record<string, string[]> = {};
  const identities: Identity[] = [];
  for (const kinfolk of DEMO_KINFOLK) {
    problems[kinfolk.porch] = [];
    identities.push(await porchIdentityOf(storesRoot, kinfolk, problems[kinfolk.porch]));
  }
  const porches: PorchReport[] = [];
  for (const self of identities) {
    const list = problems[self.kinfolk.porch];
    const others = identities.filter((i) => i !== self);
    for (const other of others) {
      if (self.fingerprint && self.fingerprint === other.fingerprint) list.push(`shares a signing key with ${other.kinfolk.porch}`);
    }
    const counts = await verifyPorch(storesRoot, self, others, list, now);
    porches.push({ porch: self.kinfolk.porch, kinfolk: self.kinfolk.id, fingerprint: self.fingerprint, ...counts, problems: list });
  }
  return { ok: porches.every((p) => p.problems.length === 0), porches };
}

function isDirectRun(): boolean {
  const entry = process.argv[1] ?? "";
  return entry.endsWith("verify-feed.ts") || entry.endsWith("verify-feed.js");
}

if (isDirectRun()) {
  // M15 #111: invalid OWNPLACE_OPERATOR_* settings refuse startup.
  requireOperatorSettings();
  const storesRoot = process.env.PUBLISH_ROOT ? resolve(process.env.PUBLISH_ROOT) : undefined;
  const report = await verifyStores(storesRoot);
  for (const p of report.porches) {
    const key = p.fingerprint ? ` key=${p.fingerprint.slice(0, 16)}…` : "";
    console.log(`verify ${p.porch}: ${p.problems.length ? "FAIL" : "OK"} kinfolk=${p.kinfolk}${key} own=${p.own} followed=${p.followed} encrypted=${p.encrypted}`);
    for (const problem of p.problems) console.error(` - ${p.porch}: ${problem}`);
  }
  console.log(`verify: ${report.ok ? "OK" : "FAIL"}`);
  if (!report.ok) process.exit(1);
}
