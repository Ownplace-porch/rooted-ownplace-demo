import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LocalFolderStore } from "@rooted/storage";
import {
  addContact,
  backendsFromEnv,
  buildPackage,
  fetchVerifiedHistoryPackage,
  isSafeHistoryId,
  publishStory,
  readAuthenticatedTimeline,
  readContacts,
  readVerifiedHistoryStory,
  removeContact,
  toPublicSkipReason,
  isPorchAddress,
  validateContact,
  validateInput,
} from "../src/index.js";

test("validateInput trims and enforces caps", () => {
  const v = validateInput({ title: "  Hi  ", body: "yo" });
  assert.equal(v.title, "Hi");
  assert.throws(() => validateInput({ title: "", body: "x" }), /required/);
  assert.throws(() => validateInput({ title: "x".repeat(141), body: "ok" }), /too long/);
  assert.throws(() => validateInput({ title: "ok", body: "x".repeat(5001) }), /too long/);
  assert.throws(() => validateInput({ title: "t", body: "b", authorId: "../evil" }), /unsafe/);
  assert.throws(() => validateInput({ title: "t", body: "b", authorId: 42 as unknown as string }), /must be a string/);
  assert.throws(() => validateInput({ title: "t", body: "b", authorName: 42 as unknown as string }), /must be a string/);
});

test("buildPackage produces verifiable manifest", async () => {
  const { hashObject } = await import("@rooted/protocol");
  const pkg = buildPackage({
    title: "T", body: "B", authorId: "k1", authorName: "K One",
    createdAt: "2026-09-20T00:00:00.000Z", storyId: "story-2026-09-20-abcd1234",
  });
  assert.equal(pkg.manifest.packageId, "story-2026-09-20-abcd1234");
  assert.equal(pkg.signature.signedManifestSha256, hashObject(pkg.manifest));
  assert.deepEqual(Object.keys(pkg.files).sort(), ["kinfolk.json", "manifest.json", "signature.json", "story.json"]);
});

test("publishStory writes the author's porch only (#100)", async () => {
  const { mkdtemp: mk } = await import("node:fs/promises");
  const tmp = await mk(join(tmpdir(), "rooted-lib-"));
  try {
    const validated = validateInput({ title: "Lib post", body: "via shared lib" });
    const res = await publishStory(validated, { root: tmp }, {
      createdAt: "2026-09-20T00:00:00.000Z",
      storyId: "story-2026-09-20-libtest1",
    });
    assert.deepEqual(res.backends, ["nextcloud-sim"]);
    assert.deepEqual(res.skipped.sort(), ["google-drive", "kevcloud"]);
    const { access } = await import("node:fs/promises");
    await assert.rejects(access(join(tmp, "google-drive-sim")), "Alex's post must not mirror to Sam's porch");
    const { readFile } = await import("node:fs/promises");
    for (const f of ["story.json", "manifest.json", "timeline.json"]) {
      const a = await readFile(join(tmp, "nextcloud-sim", ...(f === "timeline.json" ? [f] : ["timeline", res.storyId, f])));
      assert.ok(a.length > 0);
    }
    const idx = JSON.parse(await readFile(join(tmp, "nextcloud-sim", "timeline.json"), "utf8"));
    assert.ok(idx.stories.some((s: { id: string }) => s.id === res.storyId));
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test("contacts add/list/remove round-trip", async () => {
  const tmp = await mkdtemp(join(tmpdir(), "rooted-contacts-"));
  try {
    const store = new LocalFolderStore(tmp);
    assert.deepEqual((await readContacts(store)).contacts, []);
    const c = validateContact({ id: "kinfolk-jo", displayName: "Jo", address: "local:nextcloud-sim" });
    await addContact(store, c);
    await addContact(store, { ...c, address: "https://porch.example/jo" });
    const listed = (await readContacts(store)).contacts;
    assert.equal(listed.length, 1);
    assert.equal(listed[0].address, "https://porch.example/jo");
    await removeContact(store, "kinfolk-jo");
    assert.deepEqual((await readContacts(store)).contacts, []);
    assert.throws(() => validateContact({ id: "../x", displayName: "Evil", address: "local:nextcloud-sim" }), /unsafe/);
    assert.throws(() => validateContact({ id: "bad id", displayName: "Jo", address: "local:nextcloud-sim" }), /unsafe/);
    assert.throws(() => validateContact({ id: "kinfolk-jo", displayName: "Jo", address: "local:../secret" }), /address/);
    assert.throws(() => validateContact({ id: "kinfolk-jo", displayName: "Jo", address: "http://porch.example/jo" }), /address/);
    assert.equal(isPorchAddress("https://porch.example/jo"), true);
    await store.writeObject("contacts.json", new TextEncoder().encode(JSON.stringify({
      protocol: "rooted/v0.1", kind: "contacts", updatedAt: "2026-09-20T00:00:00.000Z",
      contacts: [{ id: "legacy", displayName: "Legacy", addedAt: "2026-09-20T00:00:00.000Z" }],
    }) + "\n"));
    const legacy = (await readContacts(store)).contacts;
    assert.equal(legacy.length, 1);
    assert.equal(legacy[0].id, "legacy");
    assert.equal(legacy[0].address, undefined);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test("backendsFromEnv honors PUBLISH_ROOT and skips clouds by default", () => {
  const saved = { ...process.env };
  delete process.env.KEVCLOUD_WEBDAV_URL;
  delete process.env.GOOGLE_DRIVE_SYNC;
  process.env.PUBLISH_ROOT = "/tmp/x";
  try {
    const b = backendsFromEnv("/repo");
    assert.equal(b.root, "/tmp/x");
    assert.equal(b.kevcloud, undefined);
    assert.equal(b.drive, undefined);
  } finally {
    process.env = saved;
  }
});

async function publishOne(tmp: string, title = "Real title") {
  const idDir = await mkdtemp(join(tmpdir(), "ownplace-id-"));
  const savedIdDir = process.env.OWNPLACE_IDENTITY_DIR;
  process.env.OWNPLACE_IDENTITY_DIR = idDir;
  try {
    const validated = validateInput({ title, body: "body" });
    const res = await publishStory(validated, { root: tmp }, {
      createdAt: "2026-09-20T00:00:00.000Z",
      storyId: `story-2026-09-20-${Math.floor(Math.random() * 0xffffffff).toString(16).padStart(8, "0")}`,
    });
    return res;
  } finally {
    if (savedIdDir === undefined) delete process.env.OWNPLACE_IDENTITY_DIR;
    else process.env.OWNPLACE_IDENTITY_DIR = savedIdDir;
    await rm(idDir, { recursive: true, force: true });
  }
}

test("authenticated timeline ignores forged timeline.json values", async () => {
  const tmp = await mkdtemp(join(tmpdir(), "rooted-auth-"));
  try {
    const res = await publishOne(tmp, "Real title");
    const { writeFile, readFile } = await import("node:fs/promises");
    // Forge the unsigned index: readers must not present it as authenticated.
    await writeFile(
      join(tmp, "nextcloud-sim", "timeline.json"),
      JSON.stringify({ protocol: "rooted/v0.1", kind: "timeline", updatedAt: "2026-09-20T00:00:00.000Z", stories: [{ id: res.storyId, title: "FORGED", authorId: "attacker", createdAt: "2026-09-20T00:00:00.000Z" }] }) + "\n"
    );
    const store = new LocalFolderStore(join(tmp, "nextcloud-sim"));
    const { index, skipped } = await readAuthenticatedTimeline(store, "nextcloud-sim", "2026-09-20T00:00:00.000Z");
    assert.equal(index.stories.length, 1);
    assert.equal(index.stories[0].title, "Real title");
    assert.equal(index.stories[0].verified, true);
    assert.deepEqual(skipped, []);
    void readFile;
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test("tampered history story is skipped, never displayed", async () => {
  const tmp = await mkdtemp(join(tmpdir(), "rooted-auth-"));
  try {
    const res = await publishOne(tmp);
    const { writeFile, readFile } = await import("node:fs/promises");
    const victim = join(tmp, "nextcloud-sim", "timeline", res.storyId, "story.json");
    const story = JSON.parse(await readFile(victim, "utf8"));
    await writeFile(victim, JSON.stringify({ ...story, body: "tampered" }) + "\n");
    const store = new LocalFolderStore(join(tmp, "nextcloud-sim"));
    await assert.rejects(() => fetchVerifiedHistoryPackage(store, res.storyId), /hash mismatch: story\.json/);
    const { index, skipped } = await readAuthenticatedTimeline(store, "nextcloud-sim", "2026-09-20T00:00:00.000Z");
    assert.equal(index.stories.length, 0);
    assert.equal(skipped.length, 1);
    assert.match(skipped[0].reason, /hash mismatch/);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test("missing signature and legacy placeholder are unverified", async () => {
  const tmp = await mkdtemp(join(tmpdir(), "rooted-auth-"));
  try {
    const res = await publishOne(tmp);
    const { writeFile, readFile } = await import("node:fs/promises");
    const { hashObject, createManifest, objectBytes } = await import("@rooted/protocol");
    const store = new LocalFolderStore(join(tmp, "nextcloud-sim"));
    // Missing signature file.
    await rm(join(tmp, "nextcloud-sim", "timeline", res.storyId, "signature.json"), { force: true });
    await assert.rejects(() => fetchVerifiedHistoryPackage(store, res.storyId), /missing unreadable file: signature\.json/);
    let report = await readAuthenticatedTimeline(store, "nextcloud-sim", "2026-09-20T00:00:00.000Z");
    assert.equal(report.index.stories.length, 0);
    // Legacy placeholder downgrade is not silently accepted.
    const kinfolk = JSON.parse(await readFile(join(tmp, "nextcloud-sim", "timeline", res.storyId, "kinfolk.json"), "utf8"));
    const story = JSON.parse(await readFile(join(tmp, "nextcloud-sim", "timeline", res.storyId, "story.json"), "utf8"));
    const legacy = createManifest(res.storyId, [
      { path: "kinfolk.json", contentType: "application/json", value: kinfolk },
      { path: "story.json", contentType: "application/json", value: story },
    ]);
    await writeFile(join(tmp, "nextcloud-sim", "timeline", res.storyId, "manifest.json"), objectBytes(legacy));
    await writeFile(join(tmp, "nextcloud-sim", "timeline", res.storyId, "signature.json"), objectBytes({ algorithm: "demo-placeholder", signedManifestSha256: hashObject(legacy), note: "legacy" }));
    await assert.rejects(() => fetchVerifiedHistoryPackage(store, res.storyId), /not Ed25519 signed/);
    report = await readAuthenticatedTimeline(store, "nextcloud-sim", "2026-09-20T00:00:00.000Z");
    assert.equal(report.index.stories.length, 0);
    assert.match(report.skipped[0].reason, /not Ed25519 signed/);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test("history ids are path-safe and verified story read works", async () => {
  const tmp = await mkdtemp(join(tmpdir(), "rooted-auth-"));
  try {
    const res = await publishOne(tmp, "Safe");
    const store = new LocalFolderStore(join(tmp, "nextcloud-sim"));
    assert.equal(isSafeHistoryId(res.storyId), true);
    assert.equal(isSafeHistoryId("../evil"), false);
    assert.equal((await readVerifiedHistoryStory(store, res.storyId)).title, "Safe");
    await assert.rejects(() => readVerifiedHistoryStory(store, "../evil"), /unsafe/);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test("copied history package under a different directory id is rejected", async () => {
  const tmp = await mkdtemp(join(tmpdir(), "rooted-auth-"));
  try {
    const res = await publishOne(tmp, "Original");
    const { cp } = await import("node:fs/promises");
    const copyId = `${res.storyId}-copy`;
    assert.equal(isSafeHistoryId(copyId), true);
    await cp(
      join(tmp, "nextcloud-sim", "timeline", res.storyId),
      join(tmp, "nextcloud-sim", "timeline", copyId),
      { recursive: true }
    );
    const store = new LocalFolderStore(join(tmp, "nextcloud-sim"));
    // Original still verifies; the copy must not (directory vs signed ids disagree).
    assert.equal((await readVerifiedHistoryStory(store, res.storyId)).id, res.storyId);
    await assert.rejects(() => fetchVerifiedHistoryPackage(store, copyId), /package id mismatch/);
    await assert.rejects(() => readVerifiedHistoryStory(store, copyId), /package id mismatch/);
    const { index, skipped } = await readAuthenticatedTimeline(store, "nextcloud-sim", "2026-09-20T00:00:00.000Z");
    // No duplicate verified card and no broken /api/story link for the copy.
    assert.equal(index.stories.length, 1);
    assert.equal(index.stories[0].id, res.storyId);
    assert.equal(skipped.length, 1);
    assert.equal(skipped[0].id, copyId);
    assert.match(skipped[0].reason, /package id mismatch/);
    assert.equal(index.skipped?.length, 1);
    assert.match(index.skipped?.[0].reason ?? "", /package id mismatch/);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test("public timeline skipped reasons do not leak raw storage errors", async () => {
  const tmp = await mkdtemp(join(tmpdir(), "rooted-auth-"));
  try {
    const res = await publishOne(tmp);
    await rm(join(tmp, "nextcloud-sim", "timeline", res.storyId, "signature.json"), { force: true });
    const store = new LocalFolderStore(join(tmp, "nextcloud-sim"));
    const { index, skipped } = await readAuthenticatedTimeline(store, "nextcloud-sim", "2026-09-20T00:00:00.000Z");
    assert.equal(index.stories.length, 0);
    assert.equal(skipped.length, 1);
    // Internal diagnostics keep the raw detail for operators.
    assert.match(skipped[0].reason, /missing unreadable file/);
    // Public shape served by GET /api/timeline stays path-free.
    const pub = index.skipped?.[0].reason ?? "";
    assert.match(pub, /unreadable file: signature\.json/);
    assert.doesNotMatch(pub, /ENOENT/);
    assert.doesNotMatch(pub, /tmp/);
    assert.doesNotMatch(pub, /\(/);
    assert.doesNotMatch(pub, /\//);
    // Unknown internals collapse to a generic, path-free token.
    assert.equal(toPublicSkipReason(`${res.storyId}: ENOENT open '/tmp/secret-path'`), "unverified package");
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});
