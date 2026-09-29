import test from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LocalFolderStore } from "@rooted/storage";
import {
  addContact,
  publishStory,
  readContactFollowedTimeline,
  readFollowedTimelines,
  readVerifiedFollowedStory,
  readVerifiedHistoryStory,
  tryOpenStory,
  validateContact,
} from "../src/index.js";

function x25519Pair() {
  const pair = generateKeyPairSync("x25519");
  return {
    priv: pair.privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
    pub: pair.publicKey.export({ type: "spki", format: "pem" }).toString(),
  };
}

// Remote porches never touch the network in tests.
const offline = { fetch: async () => { throw new Error("offline"); } };

// M10 demo: kinfolk-alex posts on his porch; kinfolk-bob follows alex's
// porch from hers; a fake creator drops a video post for both kinfolk.
test("follow broadcast: porch post plus creator video reach both kinfolk", async () => {
  const dir = await mkdtemp(join(tmpdir(), "rooted-follow-"));
  const savedIds = process.env.OWNPLACE_IDENTITY_DIR;
  process.env.OWNPLACE_IDENTITY_DIR = join(dir, "ids");
  try {
    const alex = x25519Pair();
    const bob = x25519Pair();
    const stranger = x25519Pair();
    const rootA = join(dir, "porch-alex");
    const rootB = join(dir, "porch-bob");
    const storeA = new LocalFolderStore(join(rootA, "nextcloud-sim"));
    const storeB = new LocalFolderStore(join(rootB, "nextcloud-sim"));

    // 1. Alex posts a public text story on his own porch.
    await publishStory(
      { title: "Porch news", body: "hello from alex", authorId: "kinfolk-alex", authorName: "Alex" },
      { root: rootA },
      { createdAt: "2026-09-24T00:00:00.000Z", storyId: "story-alex-1" },
    );

    // 2. Fake creator posts a video for both kinfolk (sealed to subscribers).
    const video = "https://example.com/creator-video.mp4";
    await publishStory(
      {
        title: "New video", body: "watch this", media: [video],
        authorId: "creator-rumble", authorName: "Rumble Creator",
      },
      { root: rootA },
      {
        createdAt: "2026-09-24T00:01:00.000Z", storyId: "story-creator-1",
        entitleReaders: [
          { readerId: "kinfolk-alex", readerPublicKey: alex.pub },
          { readerId: "kinfolk-bob", readerPublicKey: bob.pub },
        ],
      },
    );

    // 3. Bob follows Alex's porch: her timeline carries both, with origins.
    const now = "2026-09-24T00:02:00.000Z";
    const merged = await readFollowedTimelines(
      [
        { label: "bob-porch", store: storeB },
        { label: "alex-porch", store: storeA },
      ],
      now,
    );
    assert.equal(merged.stories.length, 2);
    const ids = merged.stories.map((s) => s.id).sort();
    assert.deepEqual(ids, ["story-alex-1", "story-creator-1"]);
    assert.ok(merged.stories.every((s) => s.origin === "alex-porch"));
    assert.ok(merged.skipped.every((s) => s.porch === "alex-porch" || s.porch === "bob-porch"));

    // 4. Both kinfolk open the creator video; a stranger sees metadata only.
    const sealed = await readVerifiedHistoryStory(storeA, "story-creator-1");
    assert.equal(sealed.body, "");
    assert.deepEqual(sealed.media, []);
    for (const [who, pair] of [["kinfolk-alex", alex], ["kinfolk-bob", bob]] as const) {
      const opened = tryOpenStory(sealed, pair.priv, who);
      assert.equal(opened.status, "opened");
      if (opened.status === "opened") {
        assert.equal(opened.body, "watch this");
        assert.deepEqual(opened.media, [video]);
      }
    }
    assert.equal(tryOpenStory(sealed, stranger.priv, "stranger-x").status, "not-entitled");

    // 5. A tampered package on the followed porch loses only itself.
    const junkDir = join(rootA, "nextcloud-sim/timeline/junk-nopackage");
    await mkdir(junkDir, { recursive: true });
    await writeFile(join(junkDir, "story.json"), "{not json");
    const again = await readFollowedTimelines(
      [
        { label: "bob-porch", store: storeB },
        { label: "alex-porch", store: storeA },
      ],
      now,
    );
    assert.equal(again.stories.length, 2);
    assert.ok(again.skipped.some((s) => s.porch === "alex-porch" && s.id === "junk-nopackage"));
  } finally {
    if (savedIds === undefined) delete process.env.OWNPLACE_IDENTITY_DIR;
    else process.env.OWNPLACE_IDENTITY_DIR = savedIds;
    await rm(dir, { recursive: true, force: true });
  }
});

test("follow merge: bad labels rejected, empty merge empty, id squats keep first porch", async () => {
  const dir = await mkdtemp(join(tmpdir(), "rooted-follow-edge-"));
  const savedIds = process.env.OWNPLACE_IDENTITY_DIR;
  process.env.OWNPLACE_IDENTITY_DIR = join(dir, "ids");
  try {
    const rootA = join(dir, "porch-a");
    const rootB = join(dir, "porch-b");
    const storeA = new LocalFolderStore(join(rootA, "nextcloud-sim"));
    const storeB = new LocalFolderStore(join(rootB, "nextcloud-sim"));
    const now = "2026-09-24T00:03:00.000Z";
    assert.deepEqual(await readFollowedTimelines([], now), { stories: [], skipped: [] });
    await assert.rejects(
      readFollowedTimelines([{ label: "../evil", store: storeA }], now),
      /bad porch label/,
    );
    await assert.rejects(
      readFollowedTimelines([{ label: "<img src=x>", store: storeA }], now),
      /bad porch label/,
    );
    // Same id on two porches: first-listed porch wins, deterministically.
    for (const [root, title] of [[rootA, "A version"], [rootB, "B version"]] as const) {
      await publishStory(
        { title, body: "dup", authorId: "kinfolk-x", authorName: "X" },
        { root },
        { createdAt: "2026-09-24T00:00:00.000Z", storyId: "story-dup-1" },
      );
    }
    const aFirst = await readFollowedTimelines(
      [
        { label: "porch-a", store: storeA },
        { label: "porch-b", store: storeB },
      ],
      now,
    );
    assert.equal(aFirst.stories.length, 1);
    assert.equal(aFirst.stories[0].title, "A version");
    assert.equal(aFirst.stories[0].origin, "porch-a");
    const bFirst = await readFollowedTimelines(
      [
        { label: "porch-b", store: storeB },
        { label: "porch-a", store: storeA },
      ],
      now,
    );
    assert.equal(bFirst.stories[0].title, "B version");
    assert.equal(bFirst.stories[0].origin, "porch-b");
  } finally {
    if (savedIds === undefined) delete process.env.OWNPLACE_IDENTITY_DIR;
    else process.env.OWNPLACE_IDENTITY_DIR = savedIds;
    await rm(dir, { recursive: true, force: true });
  }
});

test("contact follow: own plus two local porches merge; tamper and escape stay isolated", async () => {
  const dir = await mkdtemp(join(tmpdir(), "rooted-contact-follow-"));
  const savedIds = process.env.OWNPLACE_IDENTITY_DIR;
  process.env.OWNPLACE_IDENTITY_DIR = join(dir, "ids");
  try {
    const own = new LocalFolderStore(join(dir, "nextcloud-sim"));
    await publishStory(
      { title: "Own", body: "mine", authorId: "kinfolk-me", authorName: "Me" },
      { root: dir },
      { createdAt: "2026-09-24T00:00:00.000Z", storyId: "story-own-1" },
    );
    await publishStory(
      { title: "Alex", body: "from alex", authorId: "kinfolk-alex", authorName: "Alex" },
      { root: join(dir, "porch-alex") },
      { createdAt: "2026-09-24T00:02:00.000Z", storyId: "story-alex-1" },
    );
    await publishStory(
      { title: "Sam", body: "from sam", authorId: "kinfolk-sam", authorName: "Sam" },
      { root: join(dir, "porch-sam") },
      { createdAt: "2026-09-24T00:01:00.000Z", storyId: "story-sam-1" },
    );
    await addContact(own, validateContact({
      id: "porch-alex", displayName: "Alex", address: "local:porch-alex/nextcloud-sim",
    }));
    await addContact(own, validateContact({
      id: "porch-sam", displayName: "Sam", address: "local:porch-sam/nextcloud-sim",
    }));
    await addContact(own, validateContact({
      id: "remote-jo", displayName: "Jo", address: "https://porch.example/jo",
    }));

    const now = "2026-09-24T00:03:00.000Z";
    const merged = await readContactFollowedTimeline(dir, "nextcloud-sim", now, "nextcloud-sim", offline);
    assert.deepEqual(merged.stories.map((s) => s.id), ["story-alex-1", "story-sam-1", "story-own-1"]);
    assert.equal(merged.stories.find((s) => s.id === "story-own-1")?.origin, "nextcloud-sim");
    assert.equal(merged.stories.find((s) => s.id === "story-alex-1")?.origin, "porch-alex");
    assert.equal(merged.stories.find((s) => s.id === "story-sam-1")?.origin, "porch-sam");
    assert.ok(merged.skipped.some((s) => s.porch === "remote-jo" && s.reason === "porch unreadable"));
    const opened = await readVerifiedFollowedStory(dir, "nextcloud-sim", "story-alex-1", "nextcloud-sim", offline);
    assert.equal(opened.body, "from alex");

    // Tampered followed package loses only itself.
    await writeFile(join(dir, "porch-sam/nextcloud-sim/timeline/story-sam-1/story.json"), "{not json");
    const again = await readContactFollowedTimeline(dir, "nextcloud-sim", now, "nextcloud-sim", offline);
    assert.deepEqual(again.stories.map((s) => s.id), ["story-alex-1", "story-own-1"]);
    assert.ok(again.skipped.some((s) => s.porch === "porch-sam" && s.id === "story-sam-1"));
    assert.ok(!JSON.stringify(again).includes(dir), "skip reason leaked a path");

    // Symlink out of the stores root is not a porch.
    const outside = await mkdtemp(join(tmpdir(), "rooted-outside-"));
    await publishStory(
      { title: "Outside", body: "nope", authorId: "kinfolk-out", authorName: "Out" },
      { root: outside },
      { createdAt: "2026-09-24T00:04:00.000Z", storyId: "story-outside-1" },
    );
    await symlink(outside, join(dir, "via-parent"));
    await addContact(own, validateContact({
      id: "via-parent", displayName: "Via", address: "local:via-parent/nextcloud-sim",
    }));
    await symlink(join(outside, "nextcloud-sim"), join(dir, "escape"));
    await addContact(own, validateContact({
      id: "escape-porch", displayName: "Escape", address: "local:escape",
    }));
    const escaped = await readContactFollowedTimeline(dir, "nextcloud-sim", now, "nextcloud-sim", offline);
    assert.ok(!escaped.stories.some((s) => s.id === "story-outside-1"));
    assert.ok(escaped.skipped.some((s) => s.porch === "escape-porch" && s.reason === "bad porch address"));
    assert.ok(escaped.skipped.some((s) => s.porch === "via-parent" && s.reason === "bad porch address"));
    assert.ok(!JSON.stringify(escaped).includes(outside));
    await rm(outside, { recursive: true, force: true });

    // Address book can live on a different backend label than the own read.
    const fromDrive = await readContactFollowedTimeline(dir, "google-drive-sim", now, "nextcloud-sim", offline);
    assert.ok(fromDrive.stories.some((s) => s.id === "story-own-1" && s.origin === "google-drive-sim"));
    assert.ok(fromDrive.stories.some((s) => s.id === "story-alex-1" && s.origin === "porch-alex"));
  } finally {
    if (savedIds === undefined) delete process.env.OWNPLACE_IDENTITY_DIR;
    else process.env.OWNPLACE_IDENTITY_DIR = savedIds;
    await rm(dir, { recursive: true, force: true });
  }
});

test("contact follow: unverified own id does not fall through to a squat", async () => {
  const dir = await mkdtemp(join(tmpdir(), "rooted-contact-squat-"));
  const savedIds = process.env.OWNPLACE_IDENTITY_DIR;
  process.env.OWNPLACE_IDENTITY_DIR = join(dir, "ids");
  try {
    const own = new LocalFolderStore(join(dir, "nextcloud-sim"));
    await publishStory(
      { title: "Own dup", body: "own", authorId: "kinfolk-me", authorName: "Me" },
      { root: dir },
      { createdAt: "2026-09-24T00:00:00.000Z", storyId: "story-dup-1" },
    );
    await publishStory(
      { title: "Squat", body: "not mine", authorId: "kinfolk-alex", authorName: "Alex" },
      { root: join(dir, "porch-alex") },
      { createdAt: "2026-09-24T00:01:00.000Z", storyId: "story-dup-1" },
    );
    await addContact(own, validateContact({
      id: "porch-alex", displayName: "Alex", address: "local:porch-alex/nextcloud-sim",
    }));
    await writeFile(join(dir, "nextcloud-sim/timeline/story-dup-1/story.json"), "{not json");
    const now = "2026-09-24T00:02:00.000Z";
    const merged = await readContactFollowedTimeline(dir, "nextcloud-sim", now);
    assert.ok(!merged.stories.some((s) => s.id === "story-dup-1"));
    await assert.rejects(readVerifiedFollowedStory(dir, "nextcloud-sim", "story-dup-1"));
  } finally {
    if (savedIds === undefined) delete process.env.OWNPLACE_IDENTITY_DIR;
    else process.env.OWNPLACE_IDENTITY_DIR = savedIds;
    await rm(dir, { recursive: true, force: true });
  }
});

test("contact follow: in-porch timeline symlink is not followed or filled", async () => {
  const dir = await mkdtemp(join(tmpdir(), "rooted-contact-linkid-"));
  const savedIds = process.env.OWNPLACE_IDENTITY_DIR;
  process.env.OWNPLACE_IDENTITY_DIR = join(dir, "ids");
  try {
    const outside = await mkdtemp(join(tmpdir(), "rooted-linkid-out-"));
    await publishStory(
      { title: "Outside", body: "leaked", authorId: "kinfolk-out", authorName: "Out" },
      { root: outside },
      { createdAt: "2026-09-24T00:04:00.000Z", storyId: "story-link-1" },
    );
    const porchRoot = join(dir, "porch-link");
    await publishStory(
      { title: "Kept", body: "stays", authorId: "kinfolk-link", authorName: "Link" },
      { root: porchRoot },
      { createdAt: "2026-09-24T00:01:00.000Z", storyId: "story-kept-1" },
    );
    await mkdir(join(porchRoot, "nextcloud-sim/timeline"), { recursive: true });
    await symlink(
      join(outside, "nextcloud-sim/timeline/story-link-1"),
      join(porchRoot, "nextcloud-sim/timeline/story-link-1"),
    );
    await publishStory(
      { title: "Fill", body: "should not fill", authorId: "kinfolk-fill", authorName: "Fill" },
      { root: join(dir, "porch-fill") },
      { createdAt: "2026-09-24T00:05:00.000Z", storyId: "story-link-1" },
    );
    const own = new LocalFolderStore(join(dir, "nextcloud-sim"));
    await publishStory(
      { title: "Own", body: "mine", authorId: "kinfolk-me", authorName: "Me" },
      { root: dir },
      { createdAt: "2026-09-24T00:00:00.000Z", storyId: "story-own-1" },
    );
    await addContact(own, validateContact({
      id: "porch-link", displayName: "A Link", address: "local:porch-link/nextcloud-sim",
    }));
    await addContact(own, validateContact({
      id: "porch-fill", displayName: "Fill", address: "local:porch-fill/nextcloud-sim",
    }));
    const now = "2026-09-24T00:06:00.000Z";
    const merged = await readContactFollowedTimeline(dir, "nextcloud-sim", now);
    assert.ok(merged.stories.some((s) => s.id === "story-kept-1"));
    assert.ok(merged.stories.some((s) => s.id === "story-own-1"));
    assert.ok(!merged.stories.some((s) => s.id === "story-link-1"));
    assert.ok(!JSON.stringify(merged).includes("leaked"));
    assert.ok(!JSON.stringify(merged).includes(outside));
    await assert.rejects(readVerifiedFollowedStory(dir, "nextcloud-sim", "story-link-1"));
    await rm(outside, { recursive: true, force: true });
  } finally {
    if (savedIds === undefined) delete process.env.OWNPLACE_IDENTITY_DIR;
    else process.env.OWNPLACE_IDENTITY_DIR = savedIds;
    await rm(dir, { recursive: true, force: true });
  }
});
