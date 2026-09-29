import test from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createManifest, hashObject, objectBytes, signManifest } from "@rooted/protocol";
import { buildPackage } from "@rooted/timeline";
import { LocalFolderStore } from "@rooted/storage";
import { KinfolkClient } from "../src/client.js";
import { verifyStores } from "../src/verify-feed.js";

const testPair = generateKeyPairSync("ed25519");
const testPrivateKey = testPair.privateKey.export({ type: "pkcs8", format: "pem" }).toString();
const testPublicKey = testPair.publicKey.export({ type: "spki", format: "pem" }).toString();

async function seedSharedManifest(root: string, tamperBody?: string) {
  const kinfolk = { id: "k-test", displayName: "Test Kinfolk", publicKey: testPublicKey };
  const story = { id: "s-test", title: "t", body: "b", media: [], authorId: "k-test", createdAt: "2026-09-19T00:00:00.000Z" };
  const manifest = createManifest("pkg-test", [
    { path: "kinfolk.json", contentType: "application/json", value: kinfolk },
    { path: "story.json", contentType: "application/json", value: story },
  ], "ed25519");
  const signature = signManifest(manifest, testPrivateKey);
  for (const backend of ["nextcloud-sim", "google-drive-sim"]) {
    const store = new LocalFolderStore(join(root, backend));
    await store.writeObject("kinfolk.json", objectBytes(kinfolk));
    await store.writeObject("manifest.json", objectBytes(manifest));
    await store.writeObject("signature.json", objectBytes(signature));
    if (tamperBody !== undefined && backend === "google-drive-sim") {
      await store.writeObject("story.json", objectBytes({ ...story, body: tamperBody }));
    } else {
      await store.writeObject("story.json", objectBytes(story));
    }
  }
}

function clientFor(root: string, backend: string) {
  return new KinfolkClient(new LocalFolderStore(join(root, backend)), backend);
}

test("simulated Kinfolk clients verify the identical package on both backends", async () => {
  const root = await mkdtemp(join(tmpdir(), "rooted-sims-"));
  try {
    await seedSharedManifest(root);
    const [a, b] = await Promise.all([
      clientFor(root, "nextcloud-sim").fetchPackage(),
      clientFor(root, "google-drive-sim").fetchPackage(),
    ]);
    assert.equal(hashObject(a.story), hashObject(b.story));
    assert.equal(a.manifest.packageId, b.manifest.packageId);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("tampered story body fails verification on that backend only", async () => {
  const root = await mkdtemp(join(tmpdir(), "rooted-sims-"));
  try {
    await seedSharedManifest(root, "evil");
    await assert.rejects(
      () => clientFor(root, "google-drive-sim").fetchPackage(),
      /hash mismatch: story\.json/
    );
    const ok = await clientFor(root, "nextcloud-sim").fetchPackage();
    assert.equal(ok.manifest.packageId, "pkg-test");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("corrupt JSON reports a collected problem, not a raw SyntaxError", async () => {
  const root = await mkdtemp(join(tmpdir(), "rooted-sims-"));
  try {
    await seedSharedManifest(root);
    const store = new LocalFolderStore(join(root, "google-drive-sim"));
    await store.writeObject("story.json", new TextEncoder().encode("{not-json"));
    await assert.rejects(
      () => clientFor(root, "google-drive-sim").fetchPackage(),
      /invalid JSON: story\.json/
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("store rejects paths escaping its root", async () => {
  const root = await mkdtemp(join(tmpdir(), "rooted-sims-"));
  try {
    const store = new LocalFolderStore(join(root, "nextcloud-sim"));
    await assert.rejects(() => store.writeObject("../../evil.txt", new TextEncoder().encode("x")), /escapes root|unsafe/);
    assert.equal(await store.exists("../../evil.txt"), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("reader verifies a real Ed25519 signature and rejects a forged one", async () => {
  const root = await mkdtemp(join(tmpdir(), "rooted-signed-"));
  try {
    const pair = generateKeyPairSync("ed25519");
    const privateKey = pair.privateKey.export({ type: "pkcs8", format: "pem" }).toString();
    const publicKey = pair.publicKey.export({ type: "spki", format: "pem" }).toString();
    const kinfolk = { id: "k", displayName: "K", publicKey };
    const story = { id: "s", title: "Signed", body: "body", media: [], authorId: "k", createdAt: "2026-09-20T00:00:00.000Z" };
    const manifest = createManifest("signed", [
      { path: "kinfolk.json", contentType: "application/json", value: kinfolk },
      { path: "story.json", contentType: "application/json", value: story },
    ], "ed25519");
    const signature = signManifest(manifest, privateKey);
    if (signature.algorithm !== "ed25519") throw new Error("expected Ed25519 signature");
    const store = new LocalFolderStore(root);
    for (const [name, value] of Object.entries({ "kinfolk.json": kinfolk, "story.json": story, "manifest.json": manifest, "signature.json": signature })) {
      await store.writeObject(name, objectBytes(value));
    }
    await new KinfolkClient(store, "signed").fetchPackage();
    await store.writeObject("signature.json", objectBytes({ ...signature, value: signature.value.replace(/^./, signature.value[0] === "A" ? "B" : "A") }));
    await assert.rejects(() => new KinfolkClient(store, "signed").fetchPackage(), /Ed25519 signature verification failed/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});


test("reader rejects a legacy downgrade and an unsigned content file", async () => {
  const root = await mkdtemp(join(tmpdir(), "rooted-downgrade-"));
  try {
    const kinfolk = { id: "k", displayName: "K", publicKey: testPublicKey };
    const story = { id: "s", title: "S", body: "B", media: [], authorId: "k", createdAt: "2026-09-20T00:00:00.000Z" };
    const store = new LocalFolderStore(root);
    const legacy = createManifest("p", [
      { path: "kinfolk.json", contentType: "application/json", value: kinfolk },
      { path: "story.json", contentType: "application/json", value: story },
    ]);
    for (const [name, value] of Object.entries({ "kinfolk.json": kinfolk, "story.json": story, "manifest.json": legacy, "signature.json": { algorithm: "demo-placeholder", signedManifestSha256: hashObject(legacy), note: "legacy" } })) {
      await store.writeObject(name, objectBytes(value));
    }
    await assert.rejects(() => new KinfolkClient(store, "legacy").fetchPackage(), /not Ed25519 signed/);
    const incomplete = createManifest("p", [{ path: "kinfolk.json", contentType: "application/json", value: kinfolk }], "ed25519");
    await store.writeObject("manifest.json", objectBytes(incomplete));
    await store.writeObject("signature.json", objectBytes(signManifest(incomplete, testPrivateKey)));
    await assert.rejects(() => new KinfolkClient(store, "incomplete").fetchPackage(), /manifest must list story.json exactly once/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// --- M15 #100: per-porch verification (replaces cross-backend parity) ---

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const runLocal = promisify(execFile);

// Seed the two-Kinfolk demo into a temp root with temp keys.
async function withSeededDemo(fn: (root: string, reseed: () => Promise<unknown>) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "rooted-per-porch-"));
  const root = join(dir, "stores");
  const env: Record<string, string | undefined> = { ...process.env, PUBLISH_ROOT: root, OWNPLACE_IDENTITY_DIR: join(dir, "ids") };
  delete env.KEVCLOUD_WEBDAV_URL;
  delete env.GOOGLE_DRIVE_SYNC;
  const saved = process.env.OWNPLACE_IDENTITY_DIR;
  process.env.OWNPLACE_IDENTITY_DIR = join(dir, "ids");
  try {
    const reseed = () => runLocal(process.execPath, ["--import", "tsx", "apps/creator-bot/src/index.ts"], { cwd: repoRoot, env: env as NodeJS.ProcessEnv });
    await reseed();
    await fn(root, reseed);
  } finally {
    if (saved === undefined) delete process.env.OWNPLACE_IDENTITY_DIR;
    else process.env.OWNPLACE_IDENTITY_DIR = saved;
    await rm(dir, { recursive: true, force: true });
  }
}

function problemsOf(report: Awaited<ReturnType<typeof verifyStores>>, porch: string): string {
  return report.porches.find((p) => p.porch === porch)!.problems.join("; ");
}

test("per-porch verify: two Kinfolk, each verified on their own and following the other", async () => {
  await withSeededDemo(async (root) => {
    const report = await verifyStores(root);
    assert.equal(report.ok, true, JSON.stringify(report.porches));
    const [alex, sam] = report.porches;
    assert.equal(alex.kinfolk, "kinfolk-alex");
    assert.equal(sam.kinfolk, "kinfolk-sam");
    assert.notEqual(alex.fingerprint, sam.fingerprint);
    for (const p of report.porches) {
      assert.ok(p.own >= 1, `${p.porch} has its own verified story`);
      assert.ok(p.followed >= 1, `${p.porch} shows the other Kinfolk's story`);
    }
  });
});

test("per-porch verify: one person mirrored onto both porches fails", async () => {
  await withSeededDemo(async (root) => {
    await rm(join(root, "google-drive-sim"), { recursive: true, force: true });
    await cp(join(root, "nextcloud-sim"), join(root, "google-drive-sim"), { recursive: true });
    const report = await verifyStores(root);
    assert.equal(report.ok, false);
    assert.match(problemsOf(report, "google-drive-sim"), /not signed as kinfolk-sam/);
  });
});

test("per-porch verify: a porch that does not follow the other Kinfolk fails", async () => {
  await withSeededDemo(async (root) => {
    const path = join(root, "google-drive-sim", "contacts.json");
    const list = JSON.parse(await readFile(path, "utf8"));
    await writeFile(path, JSON.stringify({ ...list, contacts: [] }));
    const report = await verifyStores(root);
    assert.match(problemsOf(report, "google-drive-sim"), /does not follow kinfolk-alex/);
    assert.equal(problemsOf(report, "nextcloud-sim"), "", "the other porch is unaffected");
  });
});

test("per-porch verify: an unpinned follow fails", async () => {
  await withSeededDemo(async (root) => {
    const path = join(root, "nextcloud-sim", "contacts.json");
    const list = JSON.parse(await readFile(path, "utf8"));
    delete list.contacts[0].fingerprint;
    await writeFile(path, JSON.stringify(list));
    const report = await verifyStores(root);
    assert.match(problemsOf(report, "nextcloud-sim"), /not pinned to their key/);
  });
});

test("per-porch verify: a package on Sam's porch signed by another key fails", async () => {
  await withSeededDemo(async (root) => {
    // Alex's key signs a story that sits on Sam's porch.
    const pkg = buildPackage({ title: "Squat", body: "not sam", authorId: "kinfolk-alex", authorName: "Alex Rowan", createdAt: "2026-09-20T00:00:00.000Z", storyId: "story-squat" });
    const store = new LocalFolderStore(join(root, "google-drive-sim"));
    for (const [name, bytes] of Object.entries(pkg.files)) await store.writeObject(`timeline/story-squat/${name}`, bytes);
    const report = await verifyStores(root);
    assert.match(problemsOf(report, "google-drive-sim"), /history story-squat: signer does not match/);
    // Alex follows Sam pinned to Sam's key, so the squat is refused there too.
    assert.match(problemsOf(report, "nextcloud-sim"), /followed kinfolk-sam story-squat: signer does not match/);
  });
});

test("per-porch verify: tampered history fails its own porch only", async () => {
  await withSeededDemo(async (root) => {
    await writeFile(join(root, "nextcloud-sim", "timeline", "story-first-light", "story.json"), "{not json");
    const report = await verifyStores(root);
    assert.match(problemsOf(report, "nextcloud-sim"), /history story-first-light: invalid JSON: story\.json/);
    // Sam still verifies his own porch; his view of Alex reports the bad entry.
    assert.ok(!/history/.test(problemsOf(report, "google-drive-sim")));
  });
});

test("per-porch verify: two Kinfolk sharing one signing key fails", async () => {
  await withSeededDemo(async (root, reseed) => {
    // Sam's key file replaced by Alex's: same person under two names.
    const ids = join(root, "..", "ids");
    await writeFile(join(ids, "kinfolk-sam.pem"), await readFile(join(ids, "kinfolk-alex.pem")));
    await rm(join(root, "google-drive-sim"), { recursive: true, force: true });
    await reseed();
    const report = await verifyStores(root);
    assert.match(problemsOf(report, "google-drive-sim"), /shares a signing key with nextcloud-sim/);
    assert.match(problemsOf(report, "nextcloud-sim"), /shares a signing key with google-drive-sim/);
  });
});

test("per-porch verify: a porch with no signed history, and its follower, both fail", async () => {
  await withSeededDemo(async (root) => {
    // Flat latest copy stays; timeline/ history is gone from Sam's porch.
    await rm(join(root, "google-drive-sim", "timeline"), { recursive: true, force: true });
    const report = await verifyStores(root);
    assert.match(problemsOf(report, "google-drive-sim"), /no verified history signed by the porch owner/);
    assert.match(problemsOf(report, "nextcloud-sim"), /no verified entries from kinfolk-sam/);
  });
});

test("per-porch verify: a follow pointing at the wrong porch fails", async () => {
  await withSeededDemo(async (root) => {
    const path = join(root, "nextcloud-sim", "contacts.json");
    const list = JSON.parse(await readFile(path, "utf8"));
    list.contacts[0].address = "local:nextcloud-sim";
    await writeFile(path, JSON.stringify(list));
    const report = await verifyStores(root);
    assert.match(problemsOf(report, "nextcloud-sim"), /follows kinfolk-sam at the wrong address/);
  });
});
