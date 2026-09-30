import test from "node:test";
import assert from "node:assert/strict";
import { cp, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LocalFolderStore } from "@rooted/storage";
import {
  SIGNER_MISMATCH,
  addContact,
  buildInviteDocument,
  porchIdentity,
  publishStory,
  readContactFollowedTimeline,
  readContacts,
  readVerifiedFollowedStory,
  resolveInvite,
  validateContact,
} from "../src/index.js";

// M13 #94. Creator "Rowan" runs an OwnPlace at https://creator.test. The
// follower resolves Rowan's invite once, then reads with no network: every
// URL maps to a folder. `state.porch` is where the invite currently points,
// and `state.served` lists the porch paths that still answer.
// M15 #100: posts are no longer mirrored, so Rowan's second porch is an
// explicit copy of the first (what a move to another backend leaves behind).
async function copyToSecondPorch(dir: string) {
  await cp(join(dir, "creator/nextcloud-sim"), join(dir, "creator/google-drive-sim"), { recursive: true });
}

async function setup() {
  const dir = await mkdtemp(join(tmpdir(), "rooted-pinned-"));
  const savedIds = process.env.OWNPLACE_IDENTITY_DIR;
  process.env.OWNPLACE_IDENTITY_DIR = join(dir, "ids");
  await publishStory(
    { title: "Rowan 1", body: "by rowan", authorId: "kinfolk-rowan", authorName: "Rowan" },
    { root: join(dir, "creator") },
    { public: true, createdAt: "2026-09-29T00:00:00.000Z", storyId: "story-rowan-1" },
  );
  await copyToSecondPorch(dir);
  const identity = (await porchIdentity(new LocalFolderStore(join(dir, "creator/nextcloud-sim"))))!;
  const state = {
    porch: "nextcloud-sim",
    served: new Set(["nextcloud-sim", "google-drive-sim"]),
    folders: {
      "nextcloud-sim": join(dir, "creator/nextcloud-sim"),
      "google-drive-sim": join(dir, "creator/google-drive-sim"),
      "stranger-sim": join(dir, "stranger/nextcloud-sim"),
    } as Record<string, string>,
  };
  const fetch = async (url: string): Promise<Response> => {
    if (url === `https://creator.test/i/${identity.fingerprint}.json`) {
      return new Response(JSON.stringify(buildInviteDocument(identity, state.porch)));
    }
    const m = /^https:\/\/creator\.test\/porch\/([^/]+)\/(.+)$/.exec(url);
    if (m && state.served.has(m[1]) && state.folders[m[1]]) {
      try {
        return new Response(await readFile(join(state.folders[m[1]], decodeURIComponent(m[2]))));
      } catch {
        return new Response("", { status: 404 });
      }
    }
    return new Response("", { status: 404 });
  };
  const follower = join(dir, "follower");
  const contacts = new LocalFolderStore(join(follower, "nextcloud-sim"));
  const contact = await resolveInvite(`https://creator.test/i/${identity.fingerprint}`, { fetch });
  await addContact(contacts, contact);
  const read = () => readContactFollowedTimeline(follower, "nextcloud-sim", "2026-09-29T01:00:00.000Z", "nextcloud-sim", { fetch });
  const cleanup = async () => {
    if (savedIds === undefined) delete process.env.OWNPLACE_IDENTITY_DIR;
    else process.env.OWNPLACE_IDENTITY_DIR = savedIds;
    await rm(dir, { recursive: true, force: true });
  };
  return { dir, identity, state, fetch, follower, contacts, contact, read, cleanup };
}

test("pinned contact stores its invite link and fingerprint", async () => {
  const t = await setup();
  try {
    const saved = (await readContacts(t.contacts)).contacts;
    assert.equal(saved.length, 1);
    assert.equal(saved[0].fingerprint, t.identity.fingerprint);
    assert.equal(saved[0].invite, `https://creator.test/i/${t.identity.fingerprint}`);
  } finally {
    await t.cleanup();
  }
});

test("pin: a post signed by another key on the followed porch is hidden", async () => {
  const t = await setup();
  try {
    // Someone else's key writes into Rowan's porch.
    await publishStory(
      { title: "Squatter", body: "not rowan", authorId: "kinfolk-squat", authorName: "Rowan" },
      { root: join(t.dir, "creator") },
      { public: true, createdAt: "2026-09-29T00:30:00.000Z", storyId: "story-squat-1" },
    );
    await copyToSecondPorch(t.dir);
    const merged = await t.read();
    assert.deepEqual(merged.stories.map((s) => s.id), ["story-rowan-1"]);
    assert.ok(merged.skipped.some((s) => s.porch === t.contact.id && s.id === "story-squat-1" && s.reason === SIGNER_MISMATCH));
    await assert.rejects(
      readVerifiedFollowedStory(t.follower, "nextcloud-sim", "story-squat-1", "nextcloud-sim", { fetch: t.fetch }),
      /not found/,
    );
    const ok = await readVerifiedFollowedStory(t.follower, "nextcloud-sim", "story-rowan-1", "nextcloud-sim", { fetch: t.fetch });
    assert.equal(ok.body, "by rowan");

    // Same porch followed without a pin (pre-M13 contact) still shows both.
    await addContact(t.contacts, validateContact({
      id: "legacy", displayName: "Legacy", address: "https://creator.test/porch/google-drive-sim",
    }));
    const legacy = await t.read();
    assert.ok(legacy.stories.some((s) => s.id === "story-squat-1" && s.origin === "legacy"));
  } finally {
    await t.cleanup();
  }
});

test("move: creator switches porch behind the same invite; follow continues", async () => {
  const t = await setup();
  try {
    assert.deepEqual((await t.read()).stories.map((s) => s.origin), [t.contact.id]);
    // Rowan moves to the other backend; the old porch path stops answering.
    t.state.porch = "google-drive-sim";
    t.state.served = new Set(["google-drive-sim"]);
    const merged = await t.read();
    assert.deepEqual(merged.stories.map((s) => [s.id, s.origin]), [["story-rowan-1", t.contact.id]]);
    const saved = (await readContacts(t.contacts)).contacts;
    assert.equal(saved.length, 1, "no duplicate contact");
    assert.equal(saved[0].id, t.contact.id);
    assert.equal(saved[0].address, "https://creator.test/porch/google-drive-sim");
    assert.equal(saved[0].fingerprint, t.identity.fingerprint);
    // Next read goes straight to the new address.
    assert.deepEqual((await t.read()).stories.map((s) => s.id), ["story-rowan-1"]);
  } finally {
    await t.cleanup();
  }
});

test("move: invite pointing at a porch the pinned key never signed is not followed", async () => {
  const t = await setup();
  try {
    await publishStory(
      { title: "Stranger", body: "other creator", authorId: "kinfolk-stranger", authorName: "Rowan" },
      { root: join(t.dir, "stranger") },
      { public: true, createdAt: "2026-09-29T00:40:00.000Z", storyId: "story-stranger-1" },
    );
    t.state.porch = "stranger-sim";
    t.state.served = new Set(["stranger-sim"]);
    const merged = await t.read();
    assert.deepEqual(merged.stories, []);
    assert.ok(merged.skipped.some((s) => s.porch === t.contact.id && s.reason === "porch unreadable"));
    const saved = (await readContacts(t.contacts)).contacts;
    assert.equal(saved[0].address, "https://creator.test/porch/nextcloud-sim", "address unchanged");
  } finally {
    await t.cleanup();
  }
});

test("move: a pinned porch now full of another key's posts re-resolves", async () => {
  const t = await setup();
  try {
    // Old path now serves only a stranger's post; the invite points to Rowan's new porch.
    await publishStory(
      { title: "Stranger", body: "took the old path", authorId: "kinfolk-stranger", authorName: "X" },
      { root: join(t.dir, "stranger") },
      { public: true, createdAt: "2026-09-29T00:40:00.000Z", storyId: "story-stranger-1" },
    );
    t.state.folders["nextcloud-sim"] = join(t.dir, "stranger/nextcloud-sim");
    t.state.porch = "google-drive-sim";
    const merged = await t.read();
    assert.deepEqual(merged.stories.map((s) => s.id), ["story-rowan-1"]);
    assert.equal((await readContacts(t.contacts)).contacts[0].address, "https://creator.test/porch/google-drive-sim");
  } finally {
    await t.cleanup();
  }
});

test("move: a stored invite that names another creator never re-points the pin", async () => {
  const t = await setup();
  try {
    await publishStory(
      { title: "Stranger", body: "other creator", authorId: "kinfolk-stranger", authorName: "Stranger" },
      { root: join(t.dir, "stranger") },
      { public: true, createdAt: "2026-09-29T00:40:00.000Z", storyId: "story-stranger-1" },
    );
    const stranger = (await porchIdentity(new LocalFolderStore(join(t.dir, "stranger/nextcloud-sim"))))!;
    // contacts.json edited so Rowan's pinned contact carries the stranger's invite.
    const list = await readContacts(t.contacts);
    list.contacts[0].invite = `https://creator.test/i/${stranger.fingerprint}`;
    await t.contacts.writeObject("contacts.json", new TextEncoder().encode(JSON.stringify(list)));
    t.state.served = new Set(["stranger-sim"]);
    const fetch = async (url: string): Promise<Response> =>
      url === `https://creator.test/i/${stranger.fingerprint}.json`
        ? new Response(JSON.stringify(buildInviteDocument(stranger, "stranger-sim")))
        : t.fetch(url);
    const merged = await readContactFollowedTimeline(t.follower, "nextcloud-sim", "2026-09-29T01:00:00.000Z", "nextcloud-sim", { fetch });
    assert.deepEqual(merged.stories, [], "stranger posts never appear under the pinned contact");
    assert.equal((await readContacts(t.contacts)).contacts[0].address, "https://creator.test/porch/nextcloud-sim");
  } finally {
    await t.cleanup();
  }
});
