import test from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { access, mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LocalFolderStore } from "@rooted/storage";
import {
  buildPackage,
  fetchVerifiedHistoryPackage,
  isEntitlements,
  publishStory,
  readIndex,
  tryOpenStory,
  validateInput,
} from "../src/index.js";
import { createManifest, hashObject, isSealedBody, objectBytes, openGatedContent, signManifest } from "@rooted/protocol";

function x25519Pair() {
  const pair = generateKeyPairSync("x25519");
  return {
    priv: pair.privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
    pub: pair.publicKey.export({ type: "spki", format: "pem" }).toString(),
  };
}

function ed25519Pair() {
  const pair = generateKeyPairSync("ed25519");
  return {
    priv: pair.privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
    pub: pair.publicKey.export({ type: "spki", format: "pem" }).toString(),
  };
}

async function withIdDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "rooted-gated-"));
  const saved = process.env.OWNPLACE_IDENTITY_DIR;
  process.env.OWNPLACE_IDENTITY_DIR = join(dir, "ids");
  try {
    await fn(dir);
  } finally {
    if (saved === undefined) delete process.env.OWNPLACE_IDENTITY_DIR;
    else process.env.OWNPLACE_IDENTITY_DIR = saved;
    await rm(dir, { recursive: true, force: true });
  }
}

test("gated build seals the body and binds the envelope to the manifest", async () => {
  await withIdDir(async () => {
    const reader = x25519Pair();
    const pkg = buildPackage(
      {
        title: "Paid post", body: "paywalled words", authorId: "kinfolk-alex",
        authorName: "Alex", createdAt: "2026-09-20T00:00:00.000Z", storyId: "story-gated-1",
      },
      { entitle: { readerId: "reader-bob", readerPublicKey: reader.pub } },
    );
    assert.equal(pkg.story.body, "");
    assert.equal(isSealedBody(pkg.story.restricted), true);
    assert.equal(tryOpenStory(pkg.story, reader.priv, "reader-bob").status, "opened");
    assert.equal(
      tryOpenStory(pkg.story, reader.priv, "reader-bob").status === "opened" &&
        (tryOpenStory(pkg.story, reader.priv, "reader-bob") as { body: string }).body,
      "paywalled words",
    );
    // Manifest hash covers the sealed story: swapping the envelope breaks it.
    const hacked = { ...pkg.story, restricted: { ...(pkg.story.restricted as object), ciphertext: "AAAA" } };
    assert.notEqual(hashObject(hacked), pkg.manifest.objects.find((o) => o.path === "story.json")?.sha256);
  });
});

test("gated publish lands on the author's porch only; title stays public", async () => {
  await withIdDir(async (dir) => {
    const reader = x25519Pair();
    const stranger = x25519Pair();
    const root = join(dir, "stores");
    const res = await publishStory(
      { title: "Paid post", body: "paywalled words", authorId: "kinfolk-alex", authorName: "Alex" },
      { root },
      {
        createdAt: "2026-09-20T00:00:00.000Z",
        storyId: "story-gated-2",
        entitle: { readerId: "reader-bob", readerPublicKey: reader.pub },
      },
    );
    assert.ok(res.backends.includes("nextcloud-sim"));
    assert.ok(!res.backends.includes("google-drive-sim"), "M15 #100: no mirror to the other Kinfolk's porch");
    const a = await readFile(join(root, "nextcloud-sim/timeline/story-gated-2/story.json"), "utf8");
    await assert.rejects(access(join(root, "google-drive-sim")), "M15 #100: the other porch is untouched");
    for (const backend of ["nextcloud-sim"]) {
      const store = new LocalFolderStore(join(root, backend));
      const story = (await fetchVerifiedHistoryPackage(store, "story-gated-2")).story;
      assert.equal(story.body, "");
      assert.equal(tryOpenStory(story, reader.priv, "reader-bob").status, "opened");
      assert.equal(tryOpenStory(story, stranger.priv, "stranger-x").status, "not-entitled");
      assert.equal(tryOpenStory(story).status, "restricted");
      const index = await readIndex(store, backend, "2026-09-20T00:00:01.000Z");
      const entry = index.stories.find((s) => s.id === "story-gated-2");
      assert.equal(entry?.title, "Paid post");
    }
  });
});

test("verify path rejects plaintext leaks and malformed envelopes", async () => {
  await withIdDir(async (dir) => {
    const reader = x25519Pair();
    const author = ed25519Pair();
    const root = join(dir, "stores");
    async function writePkg(id: string, story: unknown): Promise<void> {
      const kinfolk = { id: "kinfolk-x", displayName: "X", publicKey: author.pub };
      const manifest = createManifest(
        id,
        [
          { path: "kinfolk.json", contentType: "application/json", value: kinfolk },
          { path: "story.json", contentType: "application/json", value: story },
        ],
        "ed25519",
      );
      const signature = signManifest(manifest, author.priv);
      const store = new LocalFolderStore(join(root, "nextcloud-sim"));
      await store.writeObject(`timeline/${id}/kinfolk.json`, objectBytes(kinfolk));
      await store.writeObject(`timeline/${id}/story.json`, objectBytes(story));
      await store.writeObject(`timeline/${id}/manifest.json`, objectBytes(manifest));
      await store.writeObject(`timeline/${id}/signature.json`, objectBytes(signature));
    }
    const { sealBody } = await import("@rooted/protocol");
    const env = sealBody("secret", reader.pub, "reader-bob");
    await writePkg("story-leak", {
      id: "story-leak", title: "t", body: "LEAK", media: [],
      authorId: "kinfolk-x", createdAt: "2026-09-20T00:00:00.000Z", restricted: env,
    });
    await writePkg("story-badenv", {
      id: "story-badenv", title: "t", body: "", media: [],
      authorId: "kinfolk-x", createdAt: "2026-09-20T00:00:00.000Z", restricted: {},
    });
    const store = new LocalFolderStore(join(root, "nextcloud-sim"));
    await assert.rejects(fetchVerifiedHistoryPackage(store, "story-leak"), /plaintext body/);
    await assert.rejects(fetchVerifiedHistoryPackage(store, "story-badenv"), /malformed/);
  });
});

test("public posts are unchanged by the gating slice", async () => {
  await withIdDir(async (dir) => {
    const pkg = buildPackage({
      title: "Free post", body: "everyone reads", authorId: "kinfolk-alex",
      authorName: "Alex", createdAt: "2026-09-20T00:00:00.000Z", storyId: "story-free-1",
    });
    assert.equal(pkg.story.body, "everyone reads");
    assert.equal("restricted" in pkg.story, false);
    assert.equal(tryOpenStory(pkg.story).status, "public");
  });
});
test("multi-reader build opens for each entitled reader; stranger blocked", async () => {
  await withIdDir(async () => {
    const a = x25519Pair();
    const b = x25519Pair();
    const c = x25519Pair();
    const stranger = x25519Pair();
    const pkg = buildPackage(
      {
        title: "Paid post", body: "paywalled words", authorId: "kinfolk-alex",
        authorName: "Alex", createdAt: "2026-09-20T00:00:00.000Z", storyId: "story-gated-multi-1",
      },
      {
        entitleReaders: [
          { readerId: "reader-a", readerPublicKey: a.pub },
          { readerId: "reader-b", readerPublicKey: b.pub },
          { readerId: "reader-c", readerPublicKey: c.pub },
        ],
      },
    );
    assert.equal(pkg.story.body, "");
    assert.equal(isSealedBody(pkg.story.restricted), true);
    assert.equal(
      (pkg.story.restricted as { wrapped: unknown[] }).wrapped.length,
      3,
    );
    for (const [pair, id] of [[a, "reader-a"], [b, "reader-b"], [c, "reader-c"]] as const) {
      const opened = tryOpenStory(pkg.story, pair.priv, id);
      assert.equal(opened.status, "opened");
      assert.equal((opened as { body: string }).body, "paywalled words");
    }
    assert.equal(tryOpenStory(pkg.story, stranger.priv, "stranger-x").status, "not-entitled");
    assert.equal(tryOpenStory(pkg.story).status, "restricted");
    // Legacy single entitle still works alongside entitleReaders (combined).
    const combined = buildPackage(
      {
        title: "Paid post", body: "paywalled words", authorId: "kinfolk-alex",
        authorName: "Alex", createdAt: "2026-09-20T00:00:00.000Z", storyId: "story-gated-multi-2",
      },
      {
        entitle: { readerId: "reader-a", readerPublicKey: a.pub },
        entitleReaders: [{ readerId: "reader-b", readerPublicKey: b.pub }],
      },
    );
    assert.equal((combined.story.restricted as { wrapped: unknown[] }).wrapped.length, 2);
    assert.equal(tryOpenStory(combined.story, a.priv, "reader-a").status, "opened");
    assert.equal(tryOpenStory(combined.story, b.priv, "reader-b").status, "opened");
  });
});

test("multi-reader publish lands on the author's porch only", async () => {
  await withIdDir(async (dir) => {
    const a = x25519Pair();
    const b = x25519Pair();
    const c = x25519Pair();
    const stranger = x25519Pair();
    const root = join(dir, "stores");
    const res = await publishStory(
      { title: "Paid post", body: "paywalled words", authorId: "kinfolk-alex", authorName: "Alex" },
      { root },
      {
        createdAt: "2026-09-20T00:00:00.000Z",
        storyId: "story-gated-multi-3",
        entitleReaders: [
          { readerId: "reader-a", readerPublicKey: a.pub },
          { readerId: "reader-b", readerPublicKey: b.pub },
          { readerId: "reader-c", readerPublicKey: c.pub },
        ],
      },
    );
    assert.ok(res.backends.includes("nextcloud-sim"));
    assert.ok(!res.backends.includes("google-drive-sim"), "M15 #100: no mirror to the other Kinfolk's porch");
    const fa = await readFile(join(root, "nextcloud-sim/timeline/story-gated-multi-3/story.json"), "utf8");
    await assert.rejects(access(join(root, "google-drive-sim")), "M15 #100: the other porch is untouched");
    for (const backend of ["nextcloud-sim"]) {
      const store = new LocalFolderStore(join(root, backend));
      const story = (await fetchVerifiedHistoryPackage(store, "story-gated-multi-3")).story;
      assert.equal(story.body, "");
      for (const [pair, id] of [[a, "reader-a"], [b, "reader-b"], [c, "reader-c"]] as const) {
        assert.equal(tryOpenStory(story, pair.priv, id).status, "opened");
      }
      assert.equal(tryOpenStory(story, stranger.priv, "stranger-x").status, "not-entitled");
      assert.equal(tryOpenStory(story).status, "restricted");
    }
  });
});

test("slice-3: three-reader entitlements sidecar is signed and verified", async () => {
  await withIdDir(async (dir) => {
    const a = x25519Pair();
    const b = x25519Pair();
    const c = x25519Pair();
    const pkg = buildPackage(
      {
        title: "Paid post", body: "paywalled words", authorId: "kinfolk-alex",
        authorName: "Alex", createdAt: "2026-09-20T00:00:00.000Z", storyId: "story-ent-3",
      },
      {
        entitleReaders: [
          { readerId: "reader-a", readerPublicKey: a.pub },
          { readerId: "reader-b", readerPublicKey: b.pub },
          { readerId: "reader-c", readerPublicKey: c.pub },
        ],
      },
    );
    // Sidecar present in files, ids only (no keys/secrets).
    assert.ok("entitlements.json" in pkg.files);
    assert.ok(pkg.entitlements);
    assert.equal(pkg.entitlements.storyId, "story-ent-3");
    assert.deepStrictEqual(pkg.entitlements.entitled, [
      { readerId: "reader-a" }, { readerId: "reader-b" }, { readerId: "reader-c" },
    ]);
    assert.ok(isEntitlements(pkg.entitlements));
    const sidecarText = new TextDecoder().decode(pkg.files["entitlements.json"]);
    assert.equal(sidecarText.includes("BEGIN PUBLIC KEY"), false);
    assert.ok(sidecarText.includes("reader-a"));
    // Manifest lists it exactly once with a matching hash (Ed25519 bound).
    const listed = pkg.manifest.objects.filter((o) => o.path === "entitlements.json");
    assert.equal(listed.length, 1);
    assert.equal(listed[0].sha256, hashObject(pkg.entitlements));
    // Round-trips through verify with the binding intact.
    const root = join(dir, "stores");
    const store = new LocalFolderStore(join(root, "nextcloud-sim"));
    for (const [name, bytes] of Object.entries(pkg.files)) {
      await store.writeObject(`timeline/story-ent-3/${name}`, bytes);
    }
    const verified = await fetchVerifiedHistoryPackage(store, "story-ent-3");
    assert.equal(verified.entitlements?.storyId, "story-ent-3");
    assert.deepStrictEqual(verified.entitlements?.entitled, [
      { readerId: "reader-a" }, { readerId: "reader-b" }, { readerId: "reader-c" },
    ]);
  });
});

test("slice-3: tampered or mismatched entitlements fail verify as collected problems", async () => {
  await withIdDir(async (dir) => {
    const a = x25519Pair();
    const author = ed25519Pair();
    const root = join(dir, "stores");
    async function writePkg(id: string, files: Record<string, unknown>): Promise<void> {
      const store = new LocalFolderStore(join(root, "nextcloud-sim"));
      for (const [name, value] of Object.entries(files)) {
        await store.writeObject(`timeline/${id}/${name}`, objectBytes(value));
      }
    }
    function signedPkg(id: string, story: unknown, entitlements: unknown, opts: { listSidecar?: boolean } = {}) {
      const kinfolk = { id: "kinfolk-x", displayName: "X", publicKey: author.pub };
      const objects: { path: string; contentType: string; value: unknown }[] = [
        { path: "kinfolk.json", contentType: "application/json", value: kinfolk },
        { path: "story.json", contentType: "application/json", value: story },
      ];
      if (opts.listSidecar !== false && entitlements !== undefined) {
        objects.push({ path: "entitlements.json", contentType: "application/json", value: entitlements });
      }
      const manifest = createManifest(id, objects, "ed25519");
      const signature = signManifest(manifest, author.priv);
      const files: Record<string, unknown> = {
        "kinfolk.json": kinfolk, "story.json": story,
        "manifest.json": manifest, "signature.json": signature,
      };
      if (entitlements !== undefined) files["entitlements.json"] = entitlements;
      return files;
    }
    const { sealBody } = await import("@rooted/protocol");
    const env = sealBody("secret", a.pub, "reader-a");
    const gatedStory = (id: string) => ({
      id, title: "t", body: "", media: [],
      authorId: "kinfolk-x", createdAt: "2026-09-20T00:00:00.000Z", restricted: env,
    });
    // Tampered bytes: valid signature over different content -> hash mismatch.
    const good = signedPkg("story-ent-tamper", gatedStory("story-ent-tamper"),
      { storyId: "story-ent-tamper", entitled: [{ readerId: "reader-a" }] });
    await writePkg("story-ent-tamper", {
      ...good,
      "entitlements.json": { storyId: "story-ent-tamper", entitled: [{ readerId: "reader-evil" }] },
    });
    // Mismatched binding: well-formed + correctly signed, but wrong storyId.
    await writePkg("story-ent-mismatch", signedPkg("story-ent-mismatch",
      gatedStory("story-ent-mismatch"),
      { storyId: "story-someone-else", entitled: [{ readerId: "reader-a" }] }));
    // Missing sidecar on a gated package.
    const missing = signedPkg("story-ent-missing", gatedStory("story-ent-missing"),
      { storyId: "story-ent-missing", entitled: [{ readerId: "reader-a" }] }, { listSidecar: false });
    delete missing["entitlements.json"];
    await writePkg("story-ent-missing", missing);
    const store = new LocalFolderStore(join(root, "nextcloud-sim"));
    // Collected problems: "<id>: ..." (never a raw error).
    await assert.rejects(fetchVerifiedHistoryPackage(store, "story-ent-tamper"), /story-ent-tamper: .*entitlements\.json/);
    await assert.rejects(fetchVerifiedHistoryPackage(store, "story-ent-mismatch"), /story-ent-mismatch: .*entitlements story mismatch/);
    await assert.rejects(fetchVerifiedHistoryPackage(store, "story-ent-missing"), /story-ent-missing: .*missing entitlements\.json/);
  });
});

test("slice-3: public posts emit no entitlements file and still verify", async () => {
  await withIdDir(async (dir) => {
    const pkg = buildPackage({
      title: "Free post", body: "everyone reads", authorId: "kinfolk-alex",
      authorName: "Alex", createdAt: "2026-09-20T00:00:00.000Z", storyId: "story-ent-free",
    });
    assert.equal("entitlements.json" in pkg.files, false);
    assert.ok(!pkg.manifest.objects.some((o) => o.path === "entitlements.json"));
    assert.equal("entitlements" in pkg, false);
    const root = join(dir, "stores");
    const store = new LocalFolderStore(join(root, "nextcloud-sim"));
    for (const [name, bytes] of Object.entries(pkg.files)) {
      await store.writeObject(`timeline/story-ent-free/${name}`, bytes);
    }
    const verified = await fetchVerifiedHistoryPackage(store, "story-ent-free");
    assert.equal(verified.entitlements, undefined);
    assert.equal(verified.story.body, "everyone reads");
  });
});

test("m4: build rejects duplicate reader ids across legacy+batch", async () => {
  await withIdDir(async () => {
    const a = x25519Pair();
    const b = x25519Pair();
    // Legacy `entitle` + batch `entitleReaders` with the same readerId.
    assert.throws(
      () =>
        buildPackage(
          {
            title: "Paid post", body: "paywalled words", authorId: "kinfolk-alex",
            authorName: "Alex", createdAt: "2026-09-20T00:00:00.000Z", storyId: "story-m4-dupe-1",
          },
          {
            entitle: { readerId: "reader-a", readerPublicKey: a.pub },
            entitleReaders: [{ readerId: "reader-a", readerPublicKey: b.pub }],
          },
        ),
      /duplicate reader id/,
    );
    // Duplicates inside the batch alone also throw (fail fast, never build).
    assert.throws(
      () =>
        buildPackage(
          {
            title: "Paid post", body: "paywalled words", authorId: "kinfolk-alex",
            authorName: "Alex", createdAt: "2026-09-20T00:00:00.000Z", storyId: "story-m4-dupe-2",
          },
          {
            entitleReaders: [
              { readerId: "reader-a", readerPublicKey: a.pub },
              { readerId: "reader-a", readerPublicKey: b.pub },
            ],
          },
        ),
      /duplicate reader id/,
    );
  });
});

test("m4: three-reader happy path entitlements match wrapped order and verify", async () => {
  await withIdDir(async (dir) => {
    const a = x25519Pair();
    const b = x25519Pair();
    const c = x25519Pair();
    const pkg = buildPackage(
      {
        title: "Paid post", body: "paywalled words", authorId: "kinfolk-alex",
        authorName: "Alex", createdAt: "2026-09-20T00:00:00.000Z", storyId: "story-m4-happy",
      },
      {
        entitleReaders: [
          { readerId: "reader-a", readerPublicKey: a.pub },
          { readerId: "reader-b", readerPublicKey: b.pub },
          { readerId: "reader-c", readerPublicKey: c.pub },
        ],
      },
    );
    const wrappedIds = (pkg.story.restricted as { wrapped: { readerId: string }[] }).wrapped.map((w) => w.readerId);
    const entitledIds = (pkg.entitlements?.entitled ?? []).map((e) => e.readerId);
    assert.deepStrictEqual(entitledIds, wrappedIds);
    assert.deepStrictEqual(entitledIds, ["reader-a", "reader-b", "reader-c"]);
    const root = join(dir, "stores");
    const store = new LocalFolderStore(join(root, "nextcloud-sim"));
    for (const [name, bytes] of Object.entries(pkg.files)) {
      await store.writeObject(`timeline/story-m4-happy/${name}`, bytes);
    }
    const verified = await fetchVerifiedHistoryPackage(store, "story-m4-happy");
    assert.deepStrictEqual((verified.entitlements?.entitled ?? []).map((e) => e.readerId), ["reader-a", "reader-b", "reader-c"]);
    assert.equal(tryOpenStory(verified.story, a.priv, "reader-a").status, "opened");
  });
});

test("m4: verify rejects sidecar-id swap and wrapped-entry removal as collected problems", async () => {
  await withIdDir(async (dir) => {
    const a = x25519Pair();
    const b = x25519Pair();
    const author = ed25519Pair();
    const root = join(dir, "stores");
    const { sealBodyForReaders } = await import("@rooted/protocol");
    function signedPkg(id: string, story: unknown, entitlements: unknown) {
      const kinfolk = { id: "kinfolk-x", displayName: "X", publicKey: author.pub };
      const manifest = createManifest(
        id,
        [
          { path: "kinfolk.json", contentType: "application/json", value: kinfolk },
          { path: "story.json", contentType: "application/json", value: story },
          { path: "entitlements.json", contentType: "application/json", value: entitlements },
        ],
        "ed25519",
      );
      const signature = signManifest(manifest, author.priv);
      return {
        "kinfolk.json": kinfolk, "story.json": story, "entitlements.json": entitlements,
        "manifest.json": manifest, "signature.json": signature,
      } as Record<string, unknown>;
    }
    async function writePkg(id: string, files: Record<string, unknown>): Promise<void> {
      const store = new LocalFolderStore(join(root, "nextcloud-sim"));
      for (const [name, value] of Object.entries(files)) {
        await store.writeObject(`timeline/${id}/${name}`, objectBytes(value));
      }
    }
    const baseStory = (id: string, readers: { readerId: string; readerPublicKey: string }[]) => ({
      id, title: "t", body: "", media: [],
      authorId: "kinfolk-x", createdAt: "2026-09-20T00:00:00.000Z",
      restricted: sealBodyForReaders("secret", readers),
    });
    // Sidecar-id swap: envelope covers [a,b] but sidecar claims [a,evil].
    // Correctly signed (hashes match) so only the M4 cross-check can catch it.
    const swapId = "story-m4-swap";
    await writePkg(swapId, signedPkg(swapId,
      baseStory(swapId, [
        { readerId: "reader-a", readerPublicKey: a.pub },
        { readerId: "reader-b", readerPublicKey: b.pub },
      ]),
      { storyId: swapId, entitled: [{ readerId: "reader-a" }, { readerId: "reader-evil" }] }));
    // Wrapped-entry removal: sidecar claims [a,b] but envelope only wraps [a].
    const cutId = "story-m4-cut";
    await writePkg(cutId, signedPkg(cutId,
      baseStory(cutId, [{ readerId: "reader-a", readerPublicKey: a.pub }]),
      { storyId: cutId, entitled: [{ readerId: "reader-a" }, { readerId: "reader-b" }] }));
    const store = new LocalFolderStore(join(root, "nextcloud-sim"));
    await assert.rejects(fetchVerifiedHistoryPackage(store, swapId), /story-m4-swap: .*entitlements\/wrapped mismatch/);
    await assert.rejects(fetchVerifiedHistoryPackage(store, cutId), /story-m4-cut: .*entitlements\/wrapped mismatch/);
    // Public skip reason stays a stable token (never raw internals).
    const { toPublicSkipReason } = await import("../src/index.js");
    assert.equal(toPublicSkipReason(`${swapId}: entitlements/wrapped mismatch`), "invalid entitlements");
  });
});

test("m4 flat-copy: gated then public clears stale flat entitlements.json", async () => {
  await withIdDir(async (dir) => {
    const reader = x25519Pair();
    const root = join(dir, "stores");
    const gatedId = "story-flat-gated-1";
    const publicId = "story-flat-public-1";
    await publishStory(
      { title: "Gated first", body: "paywalled words", authorId: "kinfolk-alex", authorName: "Alex" },
      { root },
      { createdAt: "2026-09-20T00:00:00.000Z", storyId: gatedId, entitle: { readerId: "reader-bob", readerPublicKey: reader.pub } }
    );
    for (const backend of ["nextcloud-sim"]) {
      const store = new LocalFolderStore(join(root, backend));
      assert.equal(await store.exists("entitlements.json"), true);
      const flat = JSON.parse(new TextDecoder().decode(await store.readObject("entitlements.json")));
      assert.equal(flat.storyId, gatedId);
    }
    await publishStory(
      { title: "Public second", body: "everyone reads", authorId: "kinfolk-alex", authorName: "Alex" },
      { root },
      { public: true, createdAt: "2026-09-20T00:00:01.000Z", storyId: publicId }
    );
    for (const backend of ["nextcloud-sim"]) {
      const store = new LocalFolderStore(join(root, backend));
      assert.equal(await store.exists("entitlements.json"), false);
      const gatedPkg = await fetchVerifiedHistoryPackage(store, gatedId);
      assert.equal(gatedPkg.entitlements?.storyId, gatedId);
      const publicPkg = await fetchVerifiedHistoryPackage(store, publicId);
      assert.equal(publicPkg.entitlements, undefined);
      assert.equal(publicPkg.story.body, "everyone reads");
    }
    await assert.rejects(access(join(root, "google-drive-sim")), "M15 #100: the other porch is untouched");
  });
});

test("m4 flat-copy: gated then gated rotates flat sidecar to latest story", async () => {
  await withIdDir(async (dir) => {
    const a = x25519Pair();
    const b = x25519Pair();
    const root = join(dir, "stores");
    const firstId = "story-flat-gated-a";
    const secondId = "story-flat-gated-b";
    await publishStory(
      { title: "Gated one", body: "first secret", authorId: "kinfolk-alex", authorName: "Alex" },
      { root },
      { createdAt: "2026-09-20T00:00:00.000Z", storyId: firstId, entitle: { readerId: "reader-a", readerPublicKey: a.pub } }
    );
    await publishStory(
      { title: "Gated two", body: "second secret", authorId: "kinfolk-alex", authorName: "Alex" },
      { root },
      { createdAt: "2026-09-20T00:00:01.000Z", storyId: secondId, entitle: { readerId: "reader-b", readerPublicKey: b.pub } }
    );
    for (const backend of ["nextcloud-sim"]) {
      const store = new LocalFolderStore(join(root, backend));
      assert.equal(await store.exists("entitlements.json"), true);
      const flat = JSON.parse(new TextDecoder().decode(await store.readObject("entitlements.json")));
      assert.equal(flat.storyId, secondId);
      assert.deepStrictEqual(flat.entitled, [{ readerId: "reader-b" }]);
      const firstPkg = await fetchVerifiedHistoryPackage(store, firstId);
      assert.equal(firstPkg.entitlements?.storyId, firstId);
      const secondPkg = await fetchVerifiedHistoryPackage(store, secondId);
      assert.equal(secondPkg.entitlements?.storyId, secondId);
    }
    await assert.rejects(access(join(root, "google-drive-sim")), "M15 #100: the other porch is untouched");
  });
});

test("m4 flat-copy: public then public stays absent", async () => {
  await withIdDir(async (dir) => {
    const root = join(dir, "stores");
    await publishStory(
      { title: "Free one", body: "hello", authorId: "kinfolk-alex", authorName: "Alex" },
      { root },
      { public: true, createdAt: "2026-09-20T00:00:00.000Z", storyId: "story-flat-free-a" }
    );
    await publishStory(
      { title: "Free two", body: "world", authorId: "kinfolk-alex", authorName: "Alex" },
      { root },
      { public: true, createdAt: "2026-09-20T00:00:01.000Z", storyId: "story-flat-free-b" }
    );
    for (const backend of ["nextcloud-sim"]) {
      const store = new LocalFolderStore(join(root, backend));
      assert.equal(await store.exists("entitlements.json"), false);
      const firstPkg = await fetchVerifiedHistoryPackage(store, "story-flat-free-a");
      assert.equal(firstPkg.entitlements, undefined);
      const secondPkg = await fetchVerifiedHistoryPackage(store, "story-flat-free-b");
      assert.equal(secondPkg.entitlements, undefined);
    }
  });
});

test("verify path rejects plaintext media on gated packages", async () => {
  await withIdDir(async (dir) => {
    const reader = x25519Pair();
    const author = ed25519Pair();
    const root = join(dir, "stores");
    async function writePkg(id: string, story: unknown, entitled = false): Promise<void> {
      const kinfolk = { id: "kinfolk-x", displayName: "X", publicKey: author.pub };
      const objects: { path: string; contentType: string; value: unknown }[] = [
        { path: "kinfolk.json", contentType: "application/json", value: kinfolk },
        { path: "story.json", contentType: "application/json", value: story },
      ];
      if (entitled) {
        objects.push({
          path: "entitlements.json", contentType: "application/json",
          value: { storyId: id, entitled: [{ readerId: "reader-bob" }] },
        });
      }
      const manifest = createManifest(id, objects, "ed25519");
      const signature = signManifest(manifest, author.priv);
      const store = new LocalFolderStore(join(root, "nextcloud-sim"));
      await store.writeObject(`timeline/${id}/kinfolk.json`, objectBytes(kinfolk));
      await store.writeObject(`timeline/${id}/story.json`, objectBytes(story));
      await store.writeObject(`timeline/${id}/manifest.json`, objectBytes(manifest));
      await store.writeObject(`timeline/${id}/signature.json`, objectBytes(signature));
      if (entitled) {
        await store.writeObject(
          `timeline/${id}/entitlements.json`,
          objectBytes({ storyId: id, entitled: [{ readerId: "reader-bob" }] }),
        );
      }
    }
    const { sealBody, sealGatedContent } = await import("@rooted/protocol");
    const env = sealBody("secret", reader.pub, "reader-bob");
    await writePkg("story-medialeak", {
      id: "story-medialeak", title: "t", body: "", media: ["https://poster.example/m.jpg"],
      authorId: "kinfolk-x", createdAt: "2026-09-20T00:00:00.000Z", restricted: env,
    });
    await writePkg("story-nomedia", {
      id: "story-nomedia", title: "t", body: "",
      authorId: "kinfolk-x", createdAt: "2026-09-20T00:00:00.000Z", restricted: env,
    });
    await writePkg("story-badmedia", {
      id: "story-badmedia", title: "t", body: "", media: "https://poster.example/m.jpg",
      authorId: "kinfolk-x", createdAt: "2026-09-20T00:00:00.000Z", restricted: env,
    });
    const venv = sealGatedContent("secret", ["https://poster.example/m.jpg"], [
      { readerId: "reader-bob", readerPublicKey: reader.pub },
    ]);
    await writePkg("story-v1media", {
      id: "story-v1media", title: "t", body: "", media: [],
      authorId: "kinfolk-x", createdAt: "2026-09-20T00:00:00.000Z", restricted: venv,
    }, true);
    const store = new LocalFolderStore(join(root, "nextcloud-sim"));
    await assert.rejects(fetchVerifiedHistoryPackage(store, "story-medialeak"), /plaintext media/);
    await assert.rejects(fetchVerifiedHistoryPackage(store, "story-nomedia"), /plaintext media/);
    await assert.rejects(fetchVerifiedHistoryPackage(store, "story-badmedia"), /plaintext media/);
    const v1 = await fetchVerifiedHistoryPackage(store, "story-v1media");
    assert.equal(v1.story.id, "story-v1media");
  });
});

test("M8 #65 gated build seals media with the body; clear media stays empty", async () => {
  await withIdDir(async () => {
    const reader = x25519Pair();
    const media = ["https://example.com/a.jpg", "https://example.com/b.mp4"];
    const pkg = buildPackage(
      {
        title: "Paid post", body: "paywalled words", media, authorId: "kinfolk-alex",
        authorName: "Alex", createdAt: "2026-09-20T00:00:00.000Z", storyId: "story-gated-media-1",
      },
      { entitle: { readerId: "reader-bob", readerPublicKey: reader.pub } },
    );
    assert.equal(pkg.story.body, "");
    assert.deepEqual(pkg.story.media, []);
    assert.equal(isSealedBody(pkg.story.restricted), true);
    const opened = openGatedContent(pkg.story.restricted, reader.priv, "reader-bob");
    assert.equal(opened.legacy, false);
    assert.equal(opened.body, "paywalled words");
    assert.deepEqual(opened.media, media);
  });
});

test("M8 #65 gated publish with media verifies green on the author's porch", async () => {
  await withIdDir(async (dir) => {
    const reader = x25519Pair();
    const media = ["https://example.com/a.jpg"];
    const root = join(dir, "stores");
    const validated = validateInput({
      title: "Paid post", body: "paywalled words", media,
      authorId: "kinfolk-alex", authorName: "Alex",
    });
    const res = await publishStory(validated, { root }, {
      createdAt: "2026-09-20T00:00:00.000Z",
      storyId: "story-gated-media-2",
      entitle: { readerId: "reader-bob", readerPublicKey: reader.pub },
    });
    assert.ok(res.backends.includes("nextcloud-sim"));
    assert.ok(!res.backends.includes("google-drive-sim"), "M15 #100: no mirror to the other Kinfolk's porch");
    const a = await readFile(join(root, "nextcloud-sim/timeline/story-gated-media-2/story.json"), "utf8");
    await assert.rejects(access(join(root, "google-drive-sim")), "M15 #100: the other porch is untouched");
    assert.ok(!a.includes("example.com"), "sealed media must not leak into clear JSON");
    for (const backend of ["nextcloud-sim"]) {
      const store = new LocalFolderStore(join(root, backend));
      const story = (await fetchVerifiedHistoryPackage(store, "story-gated-media-2")).story;
      assert.equal(story.body, "");
      assert.deepEqual(story.media, []);
      const opened = openGatedContent(story.restricted, reader.priv, "reader-bob");
      assert.deepEqual(opened.media, media);
    }
  });
});

test("M8 #65 publisher rejects bad media; public flow unchanged", async () => {
  assert.throws(
    () => validateInput({ title: "T", body: "B", media: ["http://example.com/a.jpg"] }),
    /media/,
  );
  assert.throws(
    () =>
      validateInput({
        title: "T", body: "B",
        media: Array.from({ length: 9 }, (_, i) => `https://example.com/${i}.jpg`),
      }),
    /media/,
  );
  assert.deepEqual(validateInput({ title: "T", body: "B" }).media, []);
  assert.throws(
    () => validateInput({ title: "T", body: "B", media: null as unknown as string[] }),
    /media/,
  );
  // Public (unentitled) packages keep the old shape: clear body, empty media.
  await withIdDir(async () => {
    const pkg = buildPackage(
      {
        title: "Public post", body: "open words", authorId: "kinfolk-alex",
        authorName: "Alex", createdAt: "2026-09-20T00:00:00.000Z", storyId: "story-public-media-1",
      },
    );
    assert.equal(pkg.story.body, "open words");
    assert.deepEqual(pkg.story.media, []);
    assert.equal(pkg.story.restricted, undefined);
  });
});
