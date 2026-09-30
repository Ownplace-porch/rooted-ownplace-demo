import test from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { access, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LocalFolderStore } from "@rooted/storage";
import {
  DEMO_KINFOLK,
  addSubscriber,
  fetchVerifiedHistoryPackage,
  publishStory,
  validateInput,
  validateSubscriber,
} from "../src/index.js";

// M15 #100: two Kinfolk, one cloud each. Nothing is mirrored.

async function withRoot(fn: (root: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "rooted-two-kinfolk-"));
  const saved = process.env.OWNPLACE_IDENTITY_DIR;
  process.env.OWNPLACE_IDENTITY_DIR = join(dir, "ids");
  try {
    await fn(join(dir, "stores"));
  } finally {
    if (saved === undefined) delete process.env.OWNPLACE_IDENTITY_DIR;
    else process.env.OWNPLACE_IDENTITY_DIR = saved;
    await rm(dir, { recursive: true, force: true });
  }
}

function x25519Pub(): string {
  return generateKeyPairSync("x25519").publicKey.export({ type: "spki", format: "pem" }).toString();
}

test("demo registry: Alex on nextcloud-sim, Sam on google-drive-sim, one cloud each", () => {
  assert.deepEqual(
    DEMO_KINFOLK.map((k) => [k.id, k.porch, k.cloud]),
    [["kinfolk-alex", "nextcloud-sim", "kevcloud"], ["kinfolk-sam", "google-drive-sim", "google-drive"]],
  );
});

test("Sam's post lands on Sam's porch only and is signed as Sam", async () => {
  await withRoot(async (root) => {
    const res = await publishStory(
      validateInput({ title: "Sam post", body: "from the drive porch", authorId: "kinfolk-sam" }),
      { root },
      { public: true, createdAt: "2026-09-29T00:00:00.000Z", storyId: "story-sam-only" },
    );
    assert.deepEqual(res.backends, ["google-drive-sim"]);
    await assert.rejects(access(join(root, "nextcloud-sim")), "Sam's post must not reach Alex's porch");
    const pkg = await fetchVerifiedHistoryPackage(new LocalFolderStore(join(root, "google-drive-sim")), "story-sam-only");
    assert.equal(pkg.kinfolk.id, "kinfolk-sam");
    // A demo Kinfolk posting without a name keeps their own name.
    assert.equal(pkg.kinfolk.displayName, "Sam");
  });
});

test("each Kinfolk syncs only to their own real cloud", async () => {
  await withRoot(async (root) => {
    // Unusable cloud settings: any attempt to use them throws locally
    // (invalid URL, missing remote) before touching a network.
    const clouds = {
      root,
      kevcloud: { baseUrl: "not-a-url", username: "u", password: "p" },
      drive: { remote: "rooted-test-no-such-remote:", folder: "nope" },
    };
    const sam = await publishStory(
      { title: "Sam", body: "b", authorId: "kinfolk-sam", authorName: "Sam" },
      { ...clouds, drive: undefined },
      { public: true, createdAt: "2026-09-29T00:00:00.000Z", storyId: "story-sam-cloud" },
    );
    assert.deepEqual(sam.backends, ["google-drive-sim"]);
    assert.ok(sam.skipped.includes("kevcloud"), "Sam never syncs to Alex's Nextcloud");
    const alex = await publishStory(
      { title: "Alex", body: "b", authorId: "kinfolk-alex", authorName: "Alex Rowan" },
      { ...clouds, kevcloud: undefined },
      { public: true, createdAt: "2026-09-29T00:00:00.000Z", storyId: "story-alex-cloud" },
    );
    assert.deepEqual(alex.backends, ["nextcloud-sim"]);
    assert.ok(alex.skipped.includes("google-drive"), "Alex never syncs to Sam's Google Drive");
  });
});

test("members-only post seals for the author's own porch roster, not the other porch's", async () => {
  await withRoot(async (root) => {
    await addSubscriber(new LocalFolderStore(join(root, "google-drive-sim")), validateSubscriber({ readerId: "reader-of-sam", readerPublicKey: x25519Pub() }));
    await addSubscriber(new LocalFolderStore(join(root, "nextcloud-sim")), validateSubscriber({ readerId: "reader-of-alex", readerPublicKey: x25519Pub() }));
    await publishStory(
      { title: "Members", body: "for Sam's readers", authorId: "kinfolk-sam", authorName: "Sam" },
      { root },
      { createdAt: "2026-09-29T00:00:00.000Z", storyId: "story-sam-members", membersOnly: true },
    );
    const pkg = await fetchVerifiedHistoryPackage(new LocalFolderStore(join(root, "google-drive-sim")), "story-sam-members");
    const entitled = pkg.entitlements?.entitled.map((e) => e.readerId).sort();
    assert.deepEqual(entitled, ["kinfolk-sam", "reader-of-sam"]);
  });
});
