import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { identityFingerprint, isFingerprint, loadOrCreateIdentity } from "@rooted/protocol";
import { LocalFolderStore } from "@rooted/storage";
import {
  addContact,
  buildInviteDocument,
  inviteContactId,
  porchIdentity,
  publishStory,
  readContactFollowedTimeline,
  readContacts,
  resolveInvite,
} from "../src/index.js";

// M12 #92: a creator instance at https://creator.test serves its invite and
// porch; a follower resolves the invite with no network (files are read
// straight from the creator's porch folder).
async function withCreator(fn: (ctx: {
  dir: string;
  porchDir: string;
  fingerprint: string;
  serve: (overrides?: Record<string, unknown>) => (url: string) => Promise<Response>;
}) => Promise<void>) {
  const dir = await mkdtemp(join(tmpdir(), "rooted-invite-"));
  const savedIds = process.env.OWNPLACE_IDENTITY_DIR;
  process.env.OWNPLACE_IDENTITY_DIR = join(dir, "ids");
  try {
    await publishStory(
      { title: "Hello kin", body: "first post", authorId: "kinfolk-rowan", authorName: "Rowan" },
      { root: join(dir, "creator") },
      { createdAt: "2026-09-28T00:00:00.000Z", storyId: "story-rowan-1" },
    );
    const porchDir = join(dir, "creator/nextcloud-sim");
    const identity = await porchIdentity(new LocalFolderStore(porchDir));
    assert.ok(identity, "creator porch has a signed identity");
    const serve = (overrides: Record<string, unknown> = {}) => async (url: string): Promise<Response> => {
      const inviteDoc = { ...buildInviteDocument(identity!, "nextcloud-sim"), ...overrides };
      if (url === `https://creator.test/i/${identity!.fingerprint}.json`) {
        return new Response(JSON.stringify(inviteDoc), { status: 200 });
      }
      const porchPrefix = "https://creator.test/porch/nextcloud-sim/";
      if (url.startsWith(porchPrefix)) {
        try {
          return new Response(await readFile(join(porchDir, decodeURIComponent(url.slice(porchPrefix.length)))), { status: 200 });
        } catch {
          return new Response("", { status: 404 });
        }
      }
      return new Response("", { status: 404 });
    };
    await fn({ dir, porchDir, fingerprint: identity!.fingerprint, serve });
  } finally {
    if (savedIds === undefined) delete process.env.OWNPLACE_IDENTITY_DIR;
    else process.env.OWNPLACE_IDENTITY_DIR = savedIds;
    await rm(dir, { recursive: true, force: true });
  }
}

test("fingerprint is stable hex SHA-256 of the signing key", async () => {
  const dir = await mkdtemp(join(tmpdir(), "rooted-fp-"));
  try {
    const { publicKey } = loadOrCreateIdentity("kinfolk-fp", dir);
    const fp = identityFingerprint(publicKey);
    assert.ok(isFingerprint(fp));
    assert.equal(identityFingerprint(publicKey), fp);
    assert.equal(identityFingerprint(loadOrCreateIdentity("kinfolk-fp", dir).publicKey), fp);
    assert.notEqual(identityFingerprint(loadOrCreateIdentity("kinfolk-other", dir).publicKey), fp);
    assert.equal(isFingerprint(fp.toUpperCase()), false);
    assert.equal(inviteContactId(fp), `op-${fp.slice(0, 12)}`);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("invite document is public-safe", async () => {
  await withCreator(async ({ dir, fingerprint, serve }) => {
    const res = await serve()(`https://creator.test/i/${fingerprint}.json`);
    const text = await res.text();
    const doc = JSON.parse(text);
    assert.deepEqual(Object.keys(doc).sort(), ["displayName", "fingerprint", "kind", "porch", "protocol"].sort().concat(doc.bio ? ["bio"] : []).sort());
    assert.equal(doc.porch, "../porch/nextcloud-sim");
    assert.ok(!text.includes(dir), "invite leaked a local path");
    assert.ok(!text.includes("PRIVATE KEY") && !text.includes("PUBLIC KEY"));
  });
});

test("follow by invite: verifies signer, stores fingerprint, merges posts", async () => {
  await withCreator(async ({ dir, fingerprint, serve }) => {
    const fetch = serve();
    const contact = await resolveInvite(`https://creator.test/i/${fingerprint}`, { fetch });
    assert.equal(contact.id, `op-${fingerprint.slice(0, 12)}`);
    assert.equal(contact.fingerprint, fingerprint);
    assert.equal(contact.displayName, "Rowan");
    assert.equal(contact.address, "https://creator.test/porch/nextcloud-sim");
    // Trailing slash on the invite link is fine.
    assert.equal((await resolveInvite(`https://creator.test/i/${fingerprint}/`, { fetch })).id, contact.id);

    const follower = new LocalFolderStore(join(dir, "follower/nextcloud-sim"));
    await addContact(follower, contact);
    const stored = (await readContacts(follower)).contacts.find((c) => c.id === contact.id);
    assert.equal(stored?.fingerprint, fingerprint, "fingerprint survives a contacts round-trip");
    const merged = await readContactFollowedTimeline(join(dir, "follower"), "nextcloud-sim", "2026-09-28T01:00:00.000Z", "nextcloud-sim", { fetch });
    assert.deepEqual(merged.stories.map((s) => [s.id, s.origin]), [["story-rowan-1", contact.id]]);
  });
});

test("follow by invite: unsigned invite fields are never trusted", async () => {
  await withCreator(async ({ dir, fingerprint, serve }) => {
    // A display name in the invite document is ignored; the signed one wins.
    const renamed = await resolveInvite(`https://creator.test/i/${fingerprint}`, { fetch: serve({ displayName: "Impostor" }) });
    assert.equal(renamed.displayName, "Rowan");

    // Link names a key that signed nothing on this porch.
    const otherFp = identityFingerprint(loadOrCreateIdentity("kinfolk-stranger", join(dir, "ids")).publicKey);
    const squat = async (url: string) =>
      url === `https://creator.test/i/${otherFp}.json`
        ? new Response(JSON.stringify({ kind: "invite", fingerprint: otherFp, displayName: "Rowan", porch: "../porch/nextcloud-sim" }))
        : serve()(url);
    await assert.rejects(resolveInvite(`https://creator.test/i/${otherFp}`, { fetch: squat }), /no verified post by this creator/);

    // Document fingerprint must equal the link's.
    await assert.rejects(resolveInvite(`https://creator.test/i/${fingerprint}`, { fetch: serve({ fingerprint: otherFp }) }), /malformed/);
    // Porch must be same-origin with the invite.
    await assert.rejects(resolveInvite(`https://creator.test/i/${fingerprint}`, { fetch: serve({ porch: "https://evil.test/porch/x" }) }), /another host/);
    await assert.rejects(resolveInvite(`https://creator.test/i/${fingerprint}`, { fetch: serve({ porch: "//evil.test/porch/x" }) }), /another host/);
    await assert.rejects(resolveInvite(`https://creator.test/i/${fingerprint}`, { fetch: serve({ kind: "story" }) }), /malformed/);
  });
});

test("follow by invite: bad links fail closed without fetching", async () => {
  const calls: string[] = [];
  const fetch = async (url: string) => {
    calls.push(url);
    return new Response("", { status: 404 });
  };
  const fp = "a".repeat(64);
  const cases: [string, RegExp][] = [
    ["not a url", /not a URL/],
    [`http://creator.test/i/${fp}`, /must be https/],
    [`https://creator.test/i/${fp}?ref=x`, /extra parts/],
    [`https://u:p@creator.test/i/${fp}`, /extra parts/],
    ["https://creator.test/i/ABC", /not an OwnPlace invite/],
    [`https://creator.test/profile/${fp}`, /not an OwnPlace invite/],
    [`https://10.0.0.5/i/${fp}`, /host refused/],
    [`https://localhost/i/${fp}`, /host refused/],
  ];
  for (const [link, expected] of cases) {
    await assert.rejects(resolveInvite(link, { fetch }), expected, link);
  }
  assert.equal(calls.length, 0);
  await assert.rejects(resolveInvite(`https://creator.test/i/${fp}`, { fetch }), /could not be loaded/);
});
