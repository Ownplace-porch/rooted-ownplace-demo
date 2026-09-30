import test from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LocalFolderStore } from "@rooted/storage";
import { loadOrCreateEncryptionIdentity } from "@rooted/protocol";
import {
  addSubscriber,
  publishStory,
  readVerifiedHistoryStory,
  tryOpenStory,
  validateSubscriber,
} from "../src/index.js";

function x25519Pair() {
  const pair = generateKeyPairSync("x25519");
  return {
    priv: pair.privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
    pub: pair.publicKey.export({ type: "spki", format: "pem" }).toString(),
  };
}

async function withRoot(fn: (root: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "rooted-sub-"));
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

test("subscriber opens posts published after subscribe; earlier posts stay closed; stranger index-only", async () => {
  await withRoot(async (root) => {
    const bob = x25519Pair();
    const stranger = x25519Pair();
    const store = new LocalFolderStore(join(root, "nextcloud-sim"));

    const before = await publishStory(
      { title: "Before sub", body: "old members only", authorId: "kinfolk-alex", authorName: "Alex" },
      { root },
      { storyId: "story-before-sub", membersOnly: true, entitle: { readerId: "kinfolk-alex", readerPublicKey: x25519Pair().pub } },
    );
    assert.equal(before.storyId, "story-before-sub");

    const sub = validateSubscriber({ readerId: "reader-bob", readerPublicKey: bob.pub });
    await addSubscriber(store, sub);

    const after = await publishStory(
      { title: "After sub", body: "new members only", authorId: "kinfolk-alex", authorName: "Alex" },
      { root },
      { storyId: "story-after-sub", membersOnly: true },
    );
    assert.equal(after.storyId, "story-after-sub");

    const oldStory = await readVerifiedHistoryStory(store, "story-before-sub");
    const newStory = await readVerifiedHistoryStory(store, "story-after-sub");

    assert.equal(tryOpenStory(oldStory, bob.priv, "reader-bob").status, "not-entitled");
    const opened = tryOpenStory(newStory, bob.priv, "reader-bob");
    assert.equal(opened.status, "opened");
    if (opened.status === "opened") assert.equal(opened.body, "new members only");
    const author = loadOrCreateEncryptionIdentity("kinfolk-alex");
    const authorOpen = tryOpenStory(newStory, author.privateKey, "kinfolk-alex");
    assert.equal(authorOpen.status, "opened");

    assert.equal(tryOpenStory(newStory, stranger.priv, "stranger-x").status, "not-entitled");
    assert.equal(newStory.title, "After sub");
    assert.equal(newStory.body, "");
  });
});

test("public posts ignore the subscriber roster", async () => {
  await withRoot(async (root) => {
    const bob = x25519Pair();
    const store = new LocalFolderStore(join(root, "nextcloud-sim"));
    await addSubscriber(store, validateSubscriber({ readerId: "reader-bob", readerPublicKey: bob.pub }));
    await publishStory(
      { title: "Public", body: "everyone can read", authorId: "kinfolk-alex", authorName: "Alex" },
      { root },
      { public: true, storyId: "story-public-sub" },
    );
    const story = await readVerifiedHistoryStory(store, "story-public-sub");
    assert.equal(story.body, "everyone can read");
    assert.equal(story.restricted, undefined);
  });
});

test("validateSubscriber rejects unsafe ids and non-PEM keys", () => {
  const pem = x25519Pair().pub;
  assert.throws(() => validateSubscriber({ readerId: "../x", readerPublicKey: pem }));
  assert.throws(() => validateSubscriber({ readerId: "bob", readerPublicKey: "not-a-key" }));
  assert.throws(() => validateSubscriber({ readerId: "bob", readerPublicKey: "" }));
});
