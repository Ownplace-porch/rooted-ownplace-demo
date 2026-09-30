import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createManifest,
  identityFingerprint,
  loadOrCreateEncryptionIdentity,
  loadOrCreateEpochKey,
  loadOrCreateIdentity,
  objectBytes,
  signManifest,
} from "@rooted/protocol";
import { LocalFolderStore } from "@rooted/storage";
import {
  ENCRYPTED_POST,
  addContact,
  buildPackage,
  fetchSignedPackage,
  fetchVerifiedHistoryPackage,
  makeStoryId,
  porchReaderKey,
  publishStory,
  readFollowedTimelines,
  readThreadedTimeline,
  readVerifiedFollowedStory,
  refreshKeyWraps,
  toPublicSkipReason,
  validateInput,
} from "../src/index.js";

// M16 #116: posts are encrypted by default to the author and their mutual
// follows. Everything a porch folder shows a stranger is ciphertext,
// signatures and the invite fields.

const NOW = "2026-09-30T00:00:00.000Z";
const SECRET = { title: "Moonlit orchard supper", body: "Bring the blue lanterns to the old pear tree", createdAt: "2031-05-17T08:09:10.000Z" };
const ALEX_ID = "story-alex-secret";

function fp(id: string): string {
  return identityFingerprint(loadOrCreateIdentity(id).publicKey);
}

async function follow(root: string, porch: string, other: { id: string; address: string }): Promise<void> {
  await addContact(new LocalFolderStore(join(root, porch)), {
    id: other.id, displayName: other.id, addedAt: NOW, address: other.address, fingerprint: fp(other.id),
  });
}

// Alex and Sam follow each other (mutual). Rowan follows Alex, Alex does not
// follow back. Alex follows Jordan, Jordan does not follow back. Everyone
// has a signed post, so everyone's encryption key is discoverable.
async function withEncryptedDemo(fn: (root: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "rooted-encrypted-"));
  const saved = process.env.OWNPLACE_IDENTITY_DIR;
  process.env.OWNPLACE_IDENTITY_DIR = join(dir, "ids");
  const root = join(dir, "stores");
  try {
    await publishStory(validateInput({ title: "Rowan", body: "hi", authorId: "kinfolk-rowan", authorName: "Rowan" }), { root: join(root, "porch-rowan") }, { public: true });
    await publishStory(validateInput({ title: "Jordan", body: "hi", authorId: "kinfolk-jordan", authorName: "Jordan" }), { root: join(root, "porch-jordan") }, { public: true });
    await follow(root, "nextcloud-sim", { id: "kinfolk-sam", address: "local:google-drive-sim" });
    await follow(root, "nextcloud-sim", { id: "kinfolk-jordan", address: "local:porch-jordan/nextcloud-sim" });
    await follow(root, "google-drive-sim", { id: "kinfolk-alex", address: "local:nextcloud-sim" });
    await follow(root, "porch-rowan/nextcloud-sim", { id: "kinfolk-alex", address: "local:nextcloud-sim" });
    await publishStory(validateInput({ title: "Sam here", body: "from sam", authorId: "kinfolk-sam" }), { root }, { createdAt: "2031-05-16T00:00:00.000Z", storyId: "story-sam-1" });
    await publishStory(validateInput({ title: SECRET.title, body: SECRET.body, authorId: "kinfolk-alex" }), { root }, { createdAt: SECRET.createdAt, storyId: ALEX_ID });
    // Sam posted before Alex's key was on a signed package, as in the seed.
    await refreshKeyWraps("kinfolk-sam", { root });
    await fn(root);
  } finally {
    if (saved === undefined) delete process.env.OWNPLACE_IDENTITY_DIR;
    else process.env.OWNPLACE_IDENTITY_DIR = saved;
    await rm(dir, { recursive: true, force: true });
  }
}

const readAs = (root: string, porch: string) => readThreadedTimeline(root, porch, NOW, porch, { readerKey: porchReaderKey(porch) });
const alexPorch = (root: string) => new LocalFolderStore(join(root, "nextcloud-sim"));

// Reads Alex's porch as a follower pinned to Alex, with that follower's key.
async function readAlexAs(root: string, readerId?: string) {
  const readerKey = readerId ? loadOrCreateEncryptionIdentity(readerId).privateKey : undefined;
  return readFollowedTimelines([{ label: "kinfolk-alex", store: alexPorch(root), pin: fp("kinfolk-alex") }], NOW, readerKey);
}

async function porchFiles(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await porchFiles(path)));
    else out.push(path);
  }
  return out;
}

test("the mutual follow reads the encrypted post; so does its author", async () => {
  await withEncryptedDemo(async (root) => {
    const sam = await readAs(root, "google-drive-sim");
    const entry = sam.stories.find((s) => s.id === ALEX_ID);
    assert.equal(entry?.title, SECRET.title);
    assert.equal(entry?.createdAt, SECRET.createdAt);
    assert.equal(entry?.encrypted, true);
    assert.equal(entry?.origin, "kinfolk-alex");
    const story = await readVerifiedFollowedStory(root, "google-drive-sim", ALEX_ID, "google-drive-sim", { readerKey: porchReaderKey("google-drive-sim") });
    assert.equal(story.body, SECRET.body);
    const alex = await readAs(root, "nextcloud-sim");
    assert.equal(alex.stories.find((s) => s.id === ALEX_ID)?.title, SECRET.title);
    assert.equal(alex.stories.find((s) => s.id === "story-sam-1")?.title, "Sam here", "Alex reads Sam too");
  });
});

test("a follower who is not mutual, or has no key, cannot read the title or body", async () => {
  await withEncryptedDemo(async (root) => {
    for (const reader of ["kinfolk-rowan", "kinfolk-jordan", undefined]) {
      const read = await readAlexAs(root, reader);
      assert.deepEqual(read.stories, [], `${reader ?? "no key"} sees no entry`);
      assert.deepEqual(read.skipped, [{ porch: "kinfolk-alex", id: ALEX_ID, reason: ENCRYPTED_POST }], "one fixed line, no content");
      const text = JSON.stringify(read);
      assert.ok(!text.includes("Moonlit") && !text.includes("lanterns") && !text.includes("2031"), "nothing about the post leaks");
      const key = reader ? loadOrCreateEncryptionIdentity(reader).privateKey : undefined;
      await assert.rejects(fetchVerifiedHistoryPackage(alexPorch(root), ALEX_ID, key), new RegExp(`${ALEX_ID}: ${ENCRYPTED_POST}$`));
    }
    // The signature still verifies without any key: strangers can follow.
    assert.equal((await fetchSignedPackage(alexPorch(root), ALEX_ID)).kinfolk.id, "kinfolk-alex");
    assert.equal(toPublicSkipReason(`${ALEX_ID}: ${ENCRYPTED_POST}`), ENCRYPTED_POST);
  });
});

test("a tampered ciphertext or wrap is rejected, never shown", async () => {
  await withEncryptedDemo(async (root) => {
    const path = join(root, "nextcloud-sim", "timeline", ALEX_ID, "story.json");
    const original = await readFile(path, "utf8");
    const doc = JSON.parse(original);
    const bytes = Buffer.from(doc.encrypted.ciphertext, "base64");
    bytes[3] ^= 0x01;
    doc.encrypted.ciphertext = bytes.toString("base64");
    await writeFile(path, `${JSON.stringify(doc)}\n`);
    const read = await readAs(root, "google-drive-sim");
    assert.ok(!read.stories.some((s) => s.id === ALEX_ID));
    assert.deepEqual(read.skipped.filter((s) => s.id === ALEX_ID).map((s) => s.reason), ["hash mismatch: story.json"]);
    await writeFile(path, original);

    // A swapped wrap hands the reader a key that fails the GCM check.
    const keysPath = join(root, "nextcloud-sim", "keys.json");
    const keys = JSON.parse(await readFile(keysPath, "utf8"));
    const forged = loadOrCreateEpochKey("kinfolk-forger");
    const { wrapEpochKey } = await import("@rooted/protocol");
    keys.epochs[0].wraps = wrapEpochKey({ epoch: keys.epochs[0].epoch, key: forged.key }, [loadOrCreateEncryptionIdentity("kinfolk-sam").publicKey]).wraps;
    await writeFile(keysPath, JSON.stringify(keys));
    const swapped = await readAs(root, "google-drive-sim");
    assert.ok(!swapped.stories.some((s) => s.id === ALEX_ID));
    assert.deepEqual(swapped.skipped.filter((s) => s.id === ALEX_ID).map((s) => s.reason), [ENCRYPTED_POST]);
  });
});

test("an encrypted package with a plaintext field beside it fails verification, even re-signed", async () => {
  await withEncryptedDemo(async (root) => {
    const pkg = buildPackage({ title: "Leak", body: "leak", authorId: "kinfolk-alex", authorName: "Alex Rowan", createdAt: NOW, storyId: "story-leak" },
      { encrypt: loadOrCreateEpochKey("kinfolk-alex") });
    const story = { ...JSON.parse(new TextDecoder().decode(pkg.files["story.json"])), title: "Leak" };
    const manifest = createManifest("story-leak", [
      { path: "kinfolk.json", contentType: "application/json", value: pkg.kinfolk },
      { path: "story.json", contentType: "application/json", value: story },
    ], "ed25519");
    const store = alexPorch(root);
    await store.writeObject("timeline/story-leak/kinfolk.json", objectBytes(pkg.kinfolk));
    await store.writeObject("timeline/story-leak/story.json", objectBytes(story));
    await store.writeObject("timeline/story-leak/manifest.json", objectBytes(manifest));
    await store.writeObject("timeline/story-leak/signature.json", objectBytes(signManifest(manifest, loadOrCreateIdentity("kinfolk-alex").privateKey)));
    await assert.rejects(fetchSignedPackage(store, "story-leak"), /encrypted package contains plaintext fields/);
    const read = await readAs(root, "google-drive-sim");
    assert.deepEqual(read.skipped.filter((s) => s.id === "story-leak").map((s) => s.reason), ["malformed encrypted story"]);
  });
});

test("a decrypted payload with an unknown field or a bad date is not shown", async () => {
  await withEncryptedDemo(async (root) => {
    const { encryptContent, canonicalJson } = await import("@rooted/protocol");
    const store = alexPorch(root);
    const kinfolk = JSON.parse(await readFile(join(root, "nextcloud-sim", "kinfolk.json"), "utf8"));
    const cases: [string, Record<string, unknown>][] = [
      ["story-extra", { v: 1, title: "t", body: "b", media: [], createdAt: NOW, tracking: "x" }],
      ["story-baddate", { v: 1, title: "t", body: "b", media: [], createdAt: "not a date" }],
    ];
    for (const [id, payload] of cases) {
      const story = { id, authorId: "kinfolk-alex", encrypted: encryptContent(canonicalJson(payload), loadOrCreateEpochKey("kinfolk-alex"), "kinfolk-alex", id) };
      const manifest = createManifest(id, [
        { path: "kinfolk.json", contentType: "application/json", value: kinfolk },
        { path: "story.json", contentType: "application/json", value: story },
      ], "ed25519");
      await store.writeObject(`timeline/${id}/kinfolk.json`, objectBytes(kinfolk));
      await store.writeObject(`timeline/${id}/story.json`, objectBytes(story));
      await store.writeObject(`timeline/${id}/manifest.json`, objectBytes(manifest));
      await store.writeObject(`timeline/${id}/signature.json`, objectBytes(signManifest(manifest, loadOrCreateIdentity("kinfolk-alex").privateKey)));
    }
    const read = await readAs(root, "google-drive-sim");
    for (const [id] of cases) {
      assert.ok(!read.stories.some((s) => s.id === id), id);
      assert.deepEqual(read.skipped.filter((s) => s.id === id).map((s) => s.reason), ["malformed story fields"], id);
      await assert.rejects(readVerifiedFollowedStory(root, "google-drive-sim", id, "google-drive-sim", { readerKey: porchReaderKey("google-drive-sim") }), /malformed story fields/);
    }
  });
});

test("no plaintext title, body or date appears anywhere in the porch files", async () => {
  await withEncryptedDemo(async (root) => {
    // An encrypted comment too: its body and target stay inside the ciphertext.
    await publishStory(validateInput({ body: "Lanterns packed and ready", authorId: "kinfolk-sam", inReplyTo: { fingerprint: fp("kinfolk-alex"), storyId: ALEX_ID } }),
      { root }, { createdAt: "2031-05-18T07:00:00.000Z", storyId: "story-sam-c1" });
    const alex = await readAs(root, "nextcloud-sim");
    assert.deepEqual(alex.stories.find((s) => s.id === ALEX_ID)?.comments?.map((c) => c.id), ["story-sam-c1"], "the comment still threads");
    const needles = ["Moonlit", "orchard", "lanterns", "Lanterns", "pear tree", "2031", "Sam here", "from sam"];
    for (const porch of ["nextcloud-sim", "google-drive-sim"]) {
      const files = await porchFiles(join(root, porch));
      assert.ok(files.length > 0);
      for (const file of files) {
        const text = await readFile(file, "utf8");
        for (const needle of needles) assert.ok(!text.includes(needle), `${needle} found in ${file}`);
      }
    }
    const hint = JSON.parse(await readFile(join(root, "nextcloud-sim", "timeline.json"), "utf8"));
    assert.deepEqual(hint, { protocol: "rooted/v0.1", kind: "timeline", stories: [{ id: ALEX_ID }] }, "bare ids, no updatedAt");
  });
});

test("wrap files contain no reader ids, fingerprints or keys", async () => {
  await withEncryptedDemo(async (root) => {
    const text = await readFile(join(root, "nextcloud-sim", "keys.json"), "utf8");
    const keys = JSON.parse(text);
    assert.deepEqual(Object.keys(keys).sort(), ["epochs", "kind", "protocol"]);
    assert.equal(keys.epochs.length, 1);
    assert.deepEqual(Object.keys(keys.epochs[0]).sort(), ["epoch", "wraps"]);
    assert.equal(keys.epochs[0].wraps.length, 2, "Alex and Sam; not Rowan or Jordan");
    for (const wrap of keys.epochs[0].wraps) {
      assert.deepEqual(Object.keys(wrap).sort(), ["ephemeralPublicKey", "keyNonce", "wrappedKey"]);
    }
    for (const id of ["kinfolk-alex", "kinfolk-sam", "kinfolk-rowan", "kinfolk-jordan"]) {
      assert.ok(!text.includes(id), `${id} named`);
      assert.ok(!text.includes(fp(id)), `${id} fingerprint named`);
      const pub = loadOrCreateEncryptionIdentity(id).publicKey.split("\n").filter((l) => l && !l.startsWith("-----")).join("");
      assert.ok(!text.includes(pub), `${id} encryption key named`);
    }
  });
});

test("--public writes today's signed plaintext format; old plaintext posts stay readable", async () => {
  await withEncryptedDemo(async (root) => {
    const res = await publishStory(validateInput({ title: "Teaser", body: "Watch the video", authorId: "kinfolk-alex" }), { root }, { public: true, createdAt: NOW });
    const story = JSON.parse(await readFile(join(root, "nextcloud-sim", "timeline", res.storyId, "story.json"), "utf8"));
    assert.equal(story.title, "Teaser");
    assert.equal(story.body, "Watch the video");
    assert.equal(story.encrypted, undefined);
    // A stranger with no key reads the public post and nothing else.
    const stranger = await readAlexAs(root);
    assert.deepEqual(stranger.stories.map((s) => [s.id, s.title, s.encrypted]), [[res.storyId, "Teaser", undefined]]);
    const hint = JSON.parse(await readFile(join(root, "nextcloud-sim", "timeline.json"), "utf8"));
    assert.deepEqual(hint.stories.map((s: { id: string; title?: string }) => [s.id, s.title]), [[res.storyId, "Teaser"], [ALEX_ID, undefined]]);
    // Sam reads both, in date order.
    const sam = await readAs(root, "google-drive-sim");
    assert.deepEqual(sam.stories.filter((s) => s.origin === "kinfolk-alex").map((s) => s.id), [ALEX_ID, res.storyId]);
  });
});

test("new story ids are opaque: random, no date or title", async () => {
  await withEncryptedDemo(async (root) => {
    const res = await publishStory(validateInput({ title: "Dated title", body: "b", authorId: "kinfolk-alex" }), { root }, { createdAt: "2031-01-02T00:00:00.000Z" });
    assert.match(res.storyId, /^story-[0-9a-f]{32}$/);
    assert.ok(!res.storyId.includes("2031") && !res.storyId.toLowerCase().includes("dated"));
    assert.notEqual(makeStoryId(), makeStoryId());
  });
});

test("a mutual follow made after a post can read it once the wraps are refreshed", async () => {
  const dir = await mkdtemp(join(tmpdir(), "rooted-encrypted-late-"));
  const saved = process.env.OWNPLACE_IDENTITY_DIR;
  process.env.OWNPLACE_IDENTITY_DIR = join(dir, "ids");
  const root = join(dir, "stores");
  try {
    await publishStory(validateInput({ title: SECRET.title, body: SECRET.body, authorId: "kinfolk-alex" }), { root }, { storyId: ALEX_ID, createdAt: SECRET.createdAt });
    await follow(root, "nextcloud-sim", { id: "kinfolk-sam", address: "local:google-drive-sim" });
    await follow(root, "google-drive-sim", { id: "kinfolk-alex", address: "local:nextcloud-sim" });
    await publishStory(validateInput({ title: "Sam here", body: "from sam", authorId: "kinfolk-sam" }), { root }, { storyId: "story-sam-1" });
    assert.ok(!(await readAs(root, "google-drive-sim")).stories.some((s) => s.id === ALEX_ID), "no wrap for Sam yet");
    await refreshKeyWraps("kinfolk-alex", { root });
    assert.equal((await readAs(root, "google-drive-sim")).stories.find((s) => s.id === ALEX_ID)?.title, SECRET.title);
  } finally {
    if (saved === undefined) delete process.env.OWNPLACE_IDENTITY_DIR;
    else process.env.OWNPLACE_IDENTITY_DIR = saved;
    await rm(dir, { recursive: true, force: true });
  }
});
