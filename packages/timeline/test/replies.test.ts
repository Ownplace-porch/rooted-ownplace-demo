import test from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createManifest, identityFingerprint, loadOrCreateIdentity, objectBytes, signManifest } from "@rooted/protocol";
import { LocalFolderStore } from "@rooted/storage";
import {
  DEMO_KINFOLK,
  REPLY_REFUSED,
  SEALED_REPLY,
  addContact,
  addSubscriber,
  buildPackage,
  checkReplyTarget,
  commentTargetFor,
  deleteReply,
  hideReply,
  hideableReply,
  publishStory,
  readThreadedTimeline,
  threadTimeline,
  validateInput,
  validateSubscriber,
  wallTargetFor,
  type TimelineEntry,
} from "../src/index.js";

// M15 #101: wall posts and comments between mutual followers. Each reply is
// a signed post on its author's own porch; readers attach it while merging.

const NOW = "2026-09-30T00:00:00.000Z";

async function withDemo(fn: (root: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "rooted-replies-"));
  const saved = process.env.OWNPLACE_IDENTITY_DIR;
  process.env.OWNPLACE_IDENTITY_DIR = join(dir, "ids");
  const root = join(dir, "stores");
  try {
    // Same shape as `npm run publish`: one post each, following each other, pinned.
    await publishStory(validateInput({ title: "Alex post", body: "from alex", authorId: "kinfolk-alex" }), { root },
      { createdAt: "2026-09-29T09:00:00.000Z", storyId: "story-alex-1" });
    await publishStory(validateInput({ title: "Sam post", body: "from sam", authorId: "kinfolk-sam" }), { root },
      { createdAt: "2026-09-29T10:00:00.000Z", storyId: "story-sam-1" });
    for (const k of DEMO_KINFOLK) {
      for (const other of DEMO_KINFOLK) {
        if (other.id === k.id) continue;
        await addContact(new LocalFolderStore(join(root, k.porch)), {
          id: other.id, displayName: other.displayName, addedAt: NOW, address: `local:${other.porch}`,
          fingerprint: fp(other.id),
        });
      }
    }
    await fn(root);
  } finally {
    if (saved === undefined) delete process.env.OWNPLACE_IDENTITY_DIR;
    else process.env.OWNPLACE_IDENTITY_DIR = saved;
    await rm(dir, { recursive: true, force: true });
  }
}

function fp(id: string): string {
  return identityFingerprint(loadOrCreateIdentity(id).publicKey);
}

async function samComments(root: string, storyId: string, body: string, replyId: string, at = "2026-09-29T11:00:00.000Z") {
  const inReplyTo = await commentTargetFor(root, "google-drive-sim", storyId);
  const validated = validateInput({ body, authorId: "kinfolk-sam", inReplyTo });
  await checkReplyTarget(root, "google-drive-sim", validated);
  return publishStory(validated, { root }, { createdAt: at, storyId: replyId });
}

const view = (root: string, porch: string) => readThreadedTimeline(root, porch, NOW);
const comments = (entries: TimelineEntry[], id: string) =>
  (entries.find((s) => s.id === id)?.comments ?? []).map((c) => [c.id, c.origin]);

test("Sam's comment is on Sam's porch and shows, verified, under Alex's post for both", async () => {
  await withDemo(async (root) => {
    await samComments(root, "story-alex-1", "nice one", "story-sam-c1");
    const pkg = JSON.parse(await readFile(join(root, "google-drive-sim/timeline/story-sam-c1/story.json"), "utf8"));
    assert.deepEqual(pkg.inReplyTo, { fingerprint: fp("kinfolk-alex"), storyId: "story-alex-1" });
    assert.equal(pkg.title, "Comment");

    const alex = await view(root, "nextcloud-sim");
    assert.equal(alex.owner, fp("kinfolk-alex"));
    assert.deepEqual(comments(alex.stories, "story-alex-1"), [["story-sam-c1", "kinfolk-sam"]]);
    const c = alex.stories.find((s) => s.id === "story-alex-1")!.comments![0];
    assert.equal(c.verified, true);
    assert.equal(c.signer, fp("kinfolk-sam"));
    assert.ok(!alex.stories.some((s) => s.id === "story-sam-c1"), "a comment is not also a plain post");

    const sam = await view(root, "google-drive-sim");
    assert.deepEqual(comments(sam.stories, "story-alex-1"), [["story-sam-c1", "google-drive-sim"]]);
  });
});

test("Sam's wall post shows on Alex's wall, labeled as Sam's, and nowhere else", async () => {
  await withDemo(async (root) => {
    const to = await wallTargetFor(root, "google-drive-sim", "kinfolk-alex");
    const validated = validateInput({ body: "hello alex", authorId: "kinfolk-sam", to });
    await checkReplyTarget(root, "google-drive-sim", validated);
    await publishStory(validated, { root }, { createdAt: "2026-09-29T12:00:00.000Z", storyId: "story-sam-w1" });

    const alex = await view(root, "nextcloud-sim");
    const wall = alex.stories.find((s) => s.id === "story-sam-w1");
    assert.ok(wall, "wall post on Alex's view");
    assert.deepEqual(wall.to, { fingerprint: fp("kinfolk-alex") });
    assert.equal(wall.origin, "kinfolk-sam");
    assert.equal(wall.signer, fp("kinfolk-sam"));
    // On Sam's own column it is not Sam's wall, so it is not shown there.
    const sam = await view(root, "google-drive-sim");
    assert.ok(!sam.stories.some((s) => s.id === "story-sam-w1"));
  });
});

test("a comment signed by a key other than the porch's pinned Kinfolk is not shown", async () => {
  await withDemo(async (root) => {
    await samComments(root, "story-alex-1", "real sam", "story-sam-c1");
    // Mallory's signed comment lands on Sam's porch folder.
    const forged = buildPackage({
      title: "Comment", body: "not sam", authorId: "kinfolk-mallory", authorName: "Sam",
      createdAt: "2026-09-29T11:30:00.000Z", storyId: "story-forged-c1",
      inReplyTo: { fingerprint: fp("kinfolk-alex"), storyId: "story-alex-1" },
    });
    const dir = join(root, "google-drive-sim/timeline/story-forged-c1");
    await mkdir(dir, { recursive: true });
    for (const [name, bytes] of Object.entries(forged.files)) await writeFile(join(dir, name), bytes);

    const alex = await view(root, "nextcloud-sim");
    assert.deepEqual(comments(alex.stories, "story-alex-1"), [["story-sam-c1", "kinfolk-sam"]]);
    assert.ok(alex.skipped.some((s) => s.id === "story-forged-c1" && s.reason === "signer does not match followed creator"));
  });
});

test("deleting Sam's comment on Sam's porch removes it from Alex's view", async () => {
  await withDemo(async (root) => {
    await samComments(root, "story-alex-1", "first", "story-sam-c1", "2026-09-29T11:00:00.000Z");
    await samComments(root, "story-alex-1", "second", "story-sam-c2", "2026-09-29T11:05:00.000Z");
    assert.deepEqual(comments((await view(root, "nextcloud-sim")).stories, "story-alex-1").map(([id]) => id), ["story-sam-c1", "story-sam-c2"]);

    const res = await deleteReply("kinfolk-sam", "story-sam-c2", { root });
    assert.deepEqual(res.backends, ["google-drive-sim"]);
    assert.deepEqual(comments((await view(root, "nextcloud-sim")).stories, "story-alex-1"), [["story-sam-c1", "kinfolk-sam"]]);
    // The flat latest copy no longer holds the deleted words.
    const flat = await readFile(join(root, "google-drive-sim/story.json"), "utf8");
    assert.ok(!flat.includes("second"));
    assert.equal(JSON.parse(flat).id, "story-sam-c1");
    const hint = JSON.parse(await readFile(join(root, "google-drive-sim/timeline.json"), "utf8"));
    assert.ok(!hint.stories.some((s: { id: string }) => s.id === "story-sam-c2"));
  });
});

async function writeSigned(dir: string, signerId: string, kinfolkId: string, story: Record<string, unknown>): Promise<void> {
  const identity = loadOrCreateIdentity(signerId);
  const kinfolk = { id: kinfolkId, displayName: kinfolkId, publicKey: identity.publicKey };
  const manifest = createManifest(String(story.id), [
    { path: "kinfolk.json", contentType: "application/json", value: kinfolk },
    { path: "story.json", contentType: "application/json", value: story },
  ], "ed25519");
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "kinfolk.json"), objectBytes(kinfolk));
  await writeFile(join(dir, "story.json"), objectBytes(story));
  await writeFile(join(dir, "manifest.json"), objectBytes(manifest));
  await writeFile(join(dir, "signature.json"), objectBytes(signManifest(manifest, identity.privateKey)));
}

test("delete only removes a reply signed as the author, by the author's key", async () => {
  await withDemo(async (root) => {
    const reply = (id: string, authorId: string) => ({
      id, title: "Comment", body: "x", media: [], authorId, createdAt: NOW,
      inReplyTo: { fingerprint: fp("kinfolk-sam"), storyId: "story-sam-1" },
    });
    // Signed by Alex's key, but as another Kinfolk id.
    await writeSigned(join(root, "nextcloud-sim/timeline/story-other-id"), "kinfolk-alex", "kinfolk-other", reply("story-other-id", "kinfolk-other"));
    // Named kinfolk-alex, but signed by another key.
    await writeSigned(join(root, "nextcloud-sim/timeline/story-other-key"), "kinfolk-mallory", "kinfolk-alex", reply("story-other-key", "kinfolk-alex"));
    for (const id of ["story-other-id", "story-other-key"]) {
      await assert.rejects(deleteReply("kinfolk-alex", id, { root }), /^Error: not found$/, id);
      await readFile(join(root, `nextcloud-sim/timeline/${id}/story.json`));
    }
  });
});

test("delete refuses plain posts, other authors' replies and unknown ids", async () => {
  await withDemo(async (root) => {
    await samComments(root, "story-alex-1", "mine", "story-sam-c1");
    await assert.rejects(deleteReply("kinfolk-sam", "story-sam-1", { root }), /only comments and wall posts can be deleted/);
    await assert.rejects(deleteReply("kinfolk-alex", "story-sam-c1", { root }), /^Error: not found$/);
    await assert.rejects(deleteReply("kinfolk-sam", "story-nope", { root }), /^Error: not found$/);
    await assert.rejects(deleteReply("kinfolk-sam", "../evil", { root }), /^Error: not found$/);
    assert.equal(comments((await view(root, "nextcloud-sim")).stories, "story-alex-1").length, 1);
  });
});

test("the target hides a reply locally; the author's view is unchanged", async () => {
  await withDemo(async (root) => {
    await samComments(root, "story-alex-1", "hide me", "story-sam-c1");
    const alexView = await view(root, "nextcloud-sim");
    const target = hideableReply(alexView, { fingerprint: fp("kinfolk-sam"), storyId: "story-sam-c1" });
    assert.ok(target);
    await hideReply(new LocalFolderStore(join(root, "nextcloud-sim")), target);
    assert.deepEqual(comments((await view(root, "nextcloud-sim")).stories, "story-alex-1"), []);
    assert.deepEqual(comments((await view(root, "google-drive-sim")).stories, "story-alex-1"), [["story-sam-c1", "google-drive-sim"]]);
  });
});

test("only replies aimed at the owner, by someone else, can be hidden", async () => {
  await withDemo(async (root) => {
    // Sam comments on Sam's own post; Alex comments on Sam's post too.
    await samComments(root, "story-sam-1", "self", "story-sam-c1");
    const alexOnSam = validateInput({ body: "hi sam", authorId: "kinfolk-alex", inReplyTo: await commentTargetFor(root, "nextcloud-sim", "story-sam-1") });
    await publishStory(alexOnSam, { root }, { createdAt: "2026-09-29T11:10:00.000Z", storyId: "story-alex-c1" });
    const alexView = await view(root, "nextcloud-sim");
    assert.equal(hideableReply(alexView, { fingerprint: fp("kinfolk-sam"), storyId: "story-sam-c1" }), null, "comment on someone else's post");
    assert.equal(hideableReply(alexView, { fingerprint: fp("kinfolk-alex"), storyId: "story-alex-c1" }), null, "own reply: delete, not hide");
    // Alex's own comment under Alex's own post: still delete, never hide.
    await publishStory(validateInput({ body: "self", authorId: "kinfolk-alex", inReplyTo: { fingerprint: fp("kinfolk-alex"), storyId: "story-alex-1" } }), { root },
      { createdAt: "2026-09-29T11:20:00.000Z", storyId: "story-alex-c2" });
    const withOwn = await view(root, "nextcloud-sim");
    assert.deepEqual(comments(withOwn.stories, "story-alex-1").map(([id]) => id), ["story-alex-c2"]);
    assert.equal(hideableReply(withOwn, { fingerprint: fp("kinfolk-alex"), storyId: "story-alex-c2" }), null, "own comment on own post");
    assert.equal(hideableReply(alexView, { fingerprint: fp("kinfolk-sam"), storyId: "story-sam-1" }), null, "plain post");
    assert.equal(hideableReply({ stories: alexView.stories }, { fingerprint: fp("kinfolk-sam"), storyId: "story-sam-c1" }), null, "no owner");
  });
});

test("reply targets must be visible, unsealed, and followed", async () => {
  await withDemo(async (root) => {
    const stranger = identityFingerprint(generateKeyPairSync("ed25519").publicKey.export({ type: "spki", format: "pem" }).toString());
    await assert.rejects(checkReplyTarget(root, "google-drive-sim", { to: { fingerprint: stranger } }), { message: REPLY_REFUSED.wall });
    await assert.rejects(wallTargetFor(root, "google-drive-sim", "kinfolk-bob"), { message: REPLY_REFUSED.wall });
    await assert.rejects(checkReplyTarget(root, "google-drive-sim", { inReplyTo: { fingerprint: fp("kinfolk-alex"), storyId: "story-nope" } }), { message: REPLY_REFUSED.comment });
    await assert.rejects(checkReplyTarget(root, "google-drive-sim", { inReplyTo: { fingerprint: stranger, storyId: "story-alex-1" } }), { message: REPLY_REFUSED.comment });
    await assert.rejects(commentTargetFor(root, "google-drive-sim", "story-nope"), { message: REPLY_REFUSED.comment });
    await checkReplyTarget(root, "google-drive-sim", { to: { fingerprint: fp("kinfolk-alex") } });
  });
});

test("comments on sealed posts are disabled in this slice, and replies are never sealed", async () => {
  await withDemo(async (root) => {
    const reader = generateKeyPairSync("x25519").publicKey.export({ type: "spki", format: "pem" }).toString();
    await addSubscriber(new LocalFolderStore(join(root, "nextcloud-sim")), validateSubscriber({ readerId: "reader-a", readerPublicKey: reader }));
    await publishStory(validateInput({ title: "Kin only", body: "sealed", authorId: "kinfolk-alex" }), { root },
      { createdAt: "2026-09-29T13:00:00.000Z", storyId: "story-alex-sealed", membersOnly: true });
    await assert.rejects(checkReplyTarget(root, "google-drive-sim", { inReplyTo: { fingerprint: fp("kinfolk-alex"), storyId: "story-alex-sealed" } }), { message: REPLY_REFUSED.sealed });
    const reply = validateInput({ body: "x", authorId: "kinfolk-alex", to: { fingerprint: fp("kinfolk-sam") } });
    await assert.rejects(publishStory(reply, { root }, { membersOnly: true }), { message: SEALED_REPLY });
    // Sam has no subscribers; the author-only seal is still refused.
    const samReply = validateInput({ body: "x", authorId: "kinfolk-sam", to: { fingerprint: fp("kinfolk-alex") } });
    await assert.rejects(publishStory(samReply, { root }, { membersOnly: true }), { message: SEALED_REPLY });
    assert.throws(() => buildPackage({ ...reply, createdAt: NOW, storyId: "story-x" }, { entitle: { readerId: "reader-a", readerPublicKey: reader } }), { message: SEALED_REPLY });
    assert.throws(() => buildPackage({ ...reply, inReplyTo: { fingerprint: fp("kinfolk-sam"), storyId: "story-sam-1" }, createdAt: NOW, storyId: "story-y" }), /not both/);

    // A comment on a sealed post that bypassed the check is still not attached.
    await publishStory(validateInput({ body: "sneaky", authorId: "kinfolk-sam", inReplyTo: { fingerprint: fp("kinfolk-alex"), storyId: "story-alex-sealed" } }), { root },
      { createdAt: "2026-09-29T13:05:00.000Z", storyId: "story-sam-c-sealed" });
    const alex = await view(root, "nextcloud-sim");
    assert.deepEqual(alex.stories.find((s) => s.id === "story-alex-sealed")?.comments, []);
    assert.ok(!alex.stories.some((s) => s.id === "story-sam-c-sealed"));
  });
});

test("threading drops orphans, sealed replies and walls that are not the owner's", () => {
  const A = "a".repeat(64);
  const S = "b".repeat(64);
  const at = (m: number) => `2026-09-29T10:${String(m).padStart(2, "0")}:00.000Z`;
  const e = (id: string, signer: string, origin: string, m: number, extra: Partial<TimelineEntry> = {}): TimelineEntry =>
    ({ id, title: "t", authorId: "x", createdAt: at(m), verified: true, signer, origin, ...extra });
  const stories = [
    e("post-a", A, "own", 1),
    e("c-late", S, "sam", 9, { inReplyTo: { fingerprint: A, storyId: "post-a" } }),
    e("c-early", S, "sam", 5, { inReplyTo: { fingerprint: A, storyId: "post-a" } }),
    e("c-wrong-signer", S, "sam", 6, { inReplyTo: { fingerprint: S, storyId: "post-a" } }),
    e("c-orphan", S, "sam", 7, { inReplyTo: { fingerprint: A, storyId: "gone" } }),
    e("c-sealed", S, "sam", 8, { sealed: true, inReplyTo: { fingerprint: A, storyId: "post-a" } }),
    e("wall-a", S, "sam", 2, { to: { fingerprint: A } }),
    e("wall-s", A, "own", 3, { to: { fingerprint: S } }),
    e("wall-sealed", S, "sam", 4, { sealed: true, to: { fingerprint: A } }),
  ];
  const out = threadTimeline(stories, "own");
  assert.equal(out.owner, A);
  assert.deepEqual(out.stories.map((s) => s.id), ["post-a", "wall-a"]);
  assert.deepEqual(out.stories[0].comments!.map((c) => c.id), ["c-early", "c-late"]);
  // Two signers on the own porch: no owner, so no wall posts.
  const noOwner = threadTimeline([...stories, e("post-x", S, "own", 10)], "own");
  assert.equal(noOwner.owner, undefined);
  assert.ok(!noOwner.stories.some((s) => s.to));
  // Hidden replies drop out.
  const hidden = threadTimeline(stories, "own", [{ fingerprint: S, storyId: "c-early" }, { fingerprint: S, storyId: "wall-a" }]);
  assert.deepEqual(hidden.stories.map((s) => s.id), ["post-a"]);
  assert.deepEqual(hidden.stories[0].comments!.map((c) => c.id), ["c-late"]);
});

test("a malformed signed reply target fails verification", async () => {
  await withDemo(async (root) => {
    const identity = loadOrCreateIdentity("kinfolk-sam");
    const kinfolk = { id: "kinfolk-sam", displayName: "Sam", publicKey: identity.publicKey };
    const story = {
      id: "story-bad-target", title: "Comment", body: "x", media: [], authorId: "kinfolk-sam", createdAt: NOW,
      inReplyTo: { fingerprint: "not-a-fingerprint", storyId: "story-alex-1" },
    };
    const manifest = createManifest("story-bad-target", [
      { path: "kinfolk.json", contentType: "application/json", value: kinfolk },
      { path: "story.json", contentType: "application/json", value: story },
    ], "ed25519");
    const dir = join(root, "google-drive-sim/timeline/story-bad-target");
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "kinfolk.json"), objectBytes(kinfolk));
    await writeFile(join(dir, "story.json"), objectBytes(story));
    await writeFile(join(dir, "manifest.json"), objectBytes(manifest));
    await writeFile(join(dir, "signature.json"), objectBytes(signManifest(manifest, identity.privateKey)));
    const alex = await view(root, "nextcloud-sim");
    assert.ok(alex.skipped.some((s) => s.id === "story-bad-target" && s.reason === "malformed reply target"));
    assert.deepEqual(alex.stories.find((s) => s.id === "story-alex-1")?.comments, []);
  });
});

test("validateInput: replies get a fixed title, targets are strict, never both", () => {
  const A = "a".repeat(64);
  assert.equal(validateInput({ body: "b", inReplyTo: { fingerprint: A, storyId: "story-1" } }).title, "Comment");
  assert.equal(validateInput({ body: "b", to: { fingerprint: A } }).title, "Wall post");
  assert.throws(() => validateInput({ body: "b" }), /title and body are required/);
  assert.throws(() => validateInput({ body: "b", to: { fingerprint: A }, inReplyTo: { fingerprint: A, storyId: "s" } }), /not both/);
  for (const to of [{ fingerprint: "A".repeat(64) }, { fingerprint: A, extra: 1 }, [A], "x"]) {
    assert.throws(() => validateInput({ body: "b", to }), /wall target/);
  }
  for (const inReplyTo of [{ fingerprint: A }, { fingerprint: A, storyId: "../x" }, { fingerprint: A, storyId: "s", x: 1 }]) {
    assert.throws(() => validateInput({ body: "b", inReplyTo }), /comment target/);
  }
});
