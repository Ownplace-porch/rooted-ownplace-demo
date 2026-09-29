import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn, type ChildProcess } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
import { buildPackage, publishStory, readContactFollowedTimeline, validateContact, addContact } from "@rooted/timeline";
import { LocalFolderStore } from "@rooted/storage";
import http from "node:http";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const serverEntry = resolve(repoRoot, "apps/ownplace-web/src/server.ts");

interface Client {
  request(method: string, path: string, rawBody?: string): Promise<{ status: number; json: unknown; raw: string }>;
  close(): void;
}

async function boot(extraEnv: Record<string, string> = {}): Promise<{ child: ChildProcess; tmp: string; client: Client }> {
  const tmp = await mkdtemp(resolve(tmpdir(), "rooted-weberr-"));
  const env: Record<string, string | undefined> = {
    ...process.env,
    PUBLISH_ROOT: tmp,
    PORT: "0",
    ...extraEnv,
  };
  // Hermetic: cloud backends never enabled in the child.
  delete env.KEVCLOUD_WEBDAV_URL;
  delete env.KEVCLOUD_WEBDAV_USER;
  delete env.KEVCLOUD_WEBDAV_PASS;
  delete env.GOOGLE_DRIVE_SYNC;
  const child = spawn(process.execPath, ["--import", "tsx", serverEntry], {
    cwd: repoRoot,
    env: env as NodeJS.ProcessEnv,
    stdio: ["ignore", "pipe", "ignore"],
  });
  // Ephemeral port: server logs the bound address (supports PORT=0).
  const port = await new Promise<number>((resolvePort, reject) => {
    const timer = setTimeout(() => reject(new Error("server did not log bound port")), 15000);
    let buf = "";
    child.stdout!.on("data", (d) => {
      buf += String(d);
      const m = buf.match(/http:\/\/127\.0\.0\.1:(\d+)/);
      if (m) {
        clearTimeout(timer);
        resolvePort(Number(m[1]));
      }
    });
    child.on("exit", () => reject(new Error("server exited before logging bound port")));
  });
  const request = (method: string, path: string, rawBody?: string, headers: Record<string, string> = {}) =>
    new Promise<{ status: number; json: unknown; raw: string }>((resolveReq, reject) => {
      const req = http.request({ host: "127.0.0.1", port, path, method, headers }, (res) => {
        let data = "";
        res.on("data", (c) => (data += c));
        res.on("end", () => {
          let json: unknown = null;
          try {
            json = JSON.parse(data);
          } catch {
            // non-JSON (e.g. text/plain 404) stays null
          }
          resolveReq({ status: res.statusCode ?? 0, json, raw: data });
        });
      });
      req.on("error", reject);
      if (rawBody !== undefined) req.write(rawBody);
      req.end();
    });
  // Readiness: health endpoint (no store dependency).
  const deadline = Date.now() + 15000;
  for (;;) {
    try {
      const r = await request("GET", "/api/health");
      if (r.status === 200) break;
    } catch {
      // not up yet
    }
    if (Date.now() > deadline) {
      child.kill("SIGKILL");
      throw new Error("server did not become ready");
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  return {
    child,
    tmp,
    client: {
      request: async (method, path, rawBody) => {
        const r = await request(method, path, rawBody);
        return { status: r.status, json: r.json, raw: r.raw };
      },
      close: () => child.kill("SIGKILL"),
    },
  };
}

// Raw engine internals must never reach the wire: no paths, no errno,
// no exception class names, no stack frames. Bare "/" was dropped as
// overbroad (it would fail legit prose); path-shaped and frame-shaped
// patterns catch real leaks instead.
const LEAK_PATTERNS: (string | RegExp)[] = [
  "\\",
  "Error",
  "error:",
  "ENOENT",
  "at ",
  ".mjs",
  ".ts:",
  /\.js:/,
  /\/[\w.-]+\//,
  /:\d+/,
];

function assertError(
  actual: { status: number; json: unknown },
  expectedStatus: number,
  expectedBody?: unknown
) {
  assert.equal(actual.status, expectedStatus);
  const body = (actual.json ?? {}) as Record<string, unknown>;
  assert.equal(typeof body.error, "string", `expected JSON error shape, got: ${JSON.stringify(actual.json)}`);
  if (expectedBody !== undefined) assert.deepStrictEqual(actual.json, expectedBody);
  for (const p of LEAK_PATTERNS) {
    const hit = typeof p === "string" ? (body.error as string).includes(p) : p.test(body.error as string);
    assert.ok(!hit, `error leaks internals (${String(p)}): ${body.error}`);
  }
}

// Covered: corrupt bodies, validation failures, bad ids/backends, missing
// contact, oversized body, wrong method, static 404, login 401/200.
// NOT covered: 500 outer-catch (needs store I/O fault injection; message is
// static "internal error" by inspection) — future work, not this slice.
test("web API corrupt-JSON and invalid input stay stable and leak-free (#49)", async () => {
  const { client, tmp } = await boot();
  try {
    // 1. Corrupt request bodies -> stable invalid-JSON message.
    for (const path of ["/api/post", "/api/contacts"]) {
      assertError(await client.request("POST", path, "{not json"), 400, { error: "invalid JSON body" });
    }

    // 2. Validation failures -> pinned stable messages, no raw internals.
    assertError(await client.request("POST", "/api/post", JSON.stringify({})), 400, {
      error: "title and body are required and must be non-empty",
    });
    // NOTE: 140/141 intentionally pin TITLE_MAX on the wire; if the constant
    // changes, this test MUST break so the new message is deliberately reviewed.
    assertError(
      await client.request("POST", "/api/post", JSON.stringify({ title: "x".repeat(141), body: "ok" })),
      400,
      { error: "title too long: max 140 characters" }
    );
    assertError(
      await client.request("POST", "/api/contacts", JSON.stringify({ id: "../evil", displayName: "Evil" })),
      400,
      { error: "contact id contains unsafe characters" }
    );

    // 3. Bad query ids/backends, missing contact -> stable messages.
    assertError(await client.request("GET", "/api/story?backend=nextcloud-sim&id=../evil"), 400, {
      error: "bad id",
    });
    assertError(await client.request("GET", "/api/timeline?backend=nope"), 400, {
      error: "unknown backend",
    });
    assertError(await client.request("DELETE", "/api/contacts?id=nope"), 404, {
      error: "contact not found",
    });

    // 4. Oversized body, wrong method, static asset miss.
    assertError(await client.request("POST", "/api/post", "x".repeat(33 * 1024)), 413, {
      error: "body too large",
    });
    assertError(await client.request("PUT", "/api/post", JSON.stringify({})), 405, {
      error: "method not allowed",
    });
    const miss = await client.request("GET", "/no-such-page");
    assert.equal(miss.status, 404);
    assert.equal(miss.json, null); // text/plain, never JSON error shape
  } finally {
    client.close();
    await rm(tmp, { recursive: true, force: true });
  }
  await new Promise((r) => setTimeout(r, 200));
});

test("web API login accepts the token and rejects anything else (#49)", async () => {
  const { client, tmp } = await boot({ OWNPLACE_WRITE_TOKEN: "t" });
  try {
    // No credentials -> 401, never a hint about the token.
    assertError(await client.request("POST", "/api/post", JSON.stringify({ title: "x", body: "y" })), 401, {
      error: "unauthorized",
    });
    assertError(
      await client.request("POST", "/api/login", JSON.stringify({ token: "wrong" })),
      401,
      { error: "unauthorized" }
    );
    const ok = await client.request("POST", "/api/login", JSON.stringify({ token: "t" }));
    assert.equal(ok.status, 200);
    assert.deepStrictEqual(ok.json, { ok: true });
  } finally {
    client.close();
    await rm(tmp, { recursive: true, force: true });
  }
});

// M8 #66: sealed reader path. Entitled key opens body+media; everyone else
// gets index metadata only; nothing sealed leaks in the clear.
test("web API sealed open serves media to the entitled key only (#66)", async () => {
  const { client, tmp } = await boot();
  try {
    const reader = generateKeyPairSync("x25519");
    const stranger = generateKeyPairSync("x25519");
    const priv = reader.privateKey.export({ type: "pkcs8", format: "pem" }).toString();
    const readerPub = reader.publicKey.export({ type: "spki", format: "pem" }).toString();
    const strangerPriv = stranger.privateKey.export({ type: "pkcs8", format: "pem" }).toString();
    const media = ["https://example.com/a.jpg", "https://example.com/b.mp4"];
    const storyId = "story-sealed-media-1";
    const savedIds = process.env.OWNPLACE_IDENTITY_DIR;
    process.env.OWNPLACE_IDENTITY_DIR = join(tmp, "ids");
    let files: Record<string, Uint8Array>;
    try {
      files = buildPackage(
        {
          title: "Gated post", body: "sealed words", media,
          authorId: "kinfolk-alex", authorName: "Alex",
          createdAt: "2026-09-20T00:00:00.000Z", storyId,
        },
        { entitle: { readerId: "reader-bob", readerPublicKey: readerPub } },
      ).files as Record<string, Uint8Array>;
    } finally {
      if (savedIds === undefined) delete process.env.OWNPLACE_IDENTITY_DIR;
      else process.env.OWNPLACE_IDENTITY_DIR = savedIds;
    }
    const dir = join(tmp, "nextcloud-sim/timeline", storyId);
    await mkdir(dir, { recursive: true });
    for (const [name, bytes] of Object.entries(files)) await writeFile(join(dir, name), bytes);

    // 1. Entitled reader opens body+media.
    const opened = await client.request(
      "POST", "/api/open",
      JSON.stringify({ id: storyId, readerKey: priv, readerId: "reader-bob" }),
    );
    assert.equal(opened.status, 200);
    assert.deepStrictEqual(opened.json, { status: "opened", body: "sealed words", media });

    // 2. Cleartext carries nothing sealed: story JSON + index have no URLs.
    const story = await client.request("GET", `/api/story?backend=nextcloud-sim&id=${storyId}`);
    assert.equal(story.status, 200);
    assert.ok(!JSON.stringify(story.json).includes("example.com"), "sealed media leaked in clear story");
    const timeline = await client.request("GET", "/api/timeline?backend=nextcloud-sim");
    assert.ok(!JSON.stringify(timeline.json).includes("example.com"), "sealed media leaked in index");

    // 3. Stranger key, missing key, bad id/backend -> fixed leak-free errors.
    assertError(
      await client.request("POST", "/api/open", JSON.stringify({ id: storyId, readerKey: strangerPriv, readerId: "stranger-x" })),
      403, { error: "cannot open" },
    );
    assertError(await client.request("POST", "/api/open", JSON.stringify({ id: storyId })), 400, {
      error: "bad reader key",
    });
    assertError(await client.request("POST", "/api/open", JSON.stringify({ id: "../evil", readerKey: priv })), 400, {
      error: "bad id",
    });
    assertError(
      await client.request("POST", "/api/open", JSON.stringify({ backend: "nope", id: storyId, readerKey: priv })),
      400, { error: "unknown backend" },
    );

    // 4. Public stories open without a key, unchanged shape.
    const posted = await client.request("POST", "/api/post", JSON.stringify({ title: "Open post", body: "open words" }));
    assert.equal(posted.status, 201);
    const pubId = ((posted.json ?? {}) as { storyId?: unknown }).storyId;
    assert.equal(typeof pubId, "string");
    const pubOpen = await client.request("POST", "/api/open", JSON.stringify({ id: pubId }));
    assert.deepStrictEqual(pubOpen.json, { status: "public", body: "open words", media: [] });
  } finally {
    client.close();
    await rm(tmp, { recursive: true, force: true });
  }
  await new Promise((r) => setTimeout(r, 200));
});

test("web timeline merges local followed porches and isolates tamper (#76)", async () => {
  const { client, tmp } = await boot();
  const savedIds = process.env.OWNPLACE_IDENTITY_DIR;
  process.env.OWNPLACE_IDENTITY_DIR = join(tmp, "ids");
  try {
    await publishStory(
      { title: "Own", body: "mine", authorId: "kinfolk-me", authorName: "Me" },
      { root: tmp },
      { createdAt: "2026-09-24T00:00:00.000Z", storyId: "story-own-1" },
    );
    await publishStory(
      { title: "Alex", body: "from alex", authorId: "kinfolk-alex", authorName: "Alex" },
      { root: join(tmp, "porch-alex") },
      { createdAt: "2026-09-24T00:02:00.000Z", storyId: "story-alex-1" },
    );
    await publishStory(
      { title: "Sam", body: "from sam", authorId: "kinfolk-sam", authorName: "Sam" },
      { root: join(tmp, "porch-sam") },
      { createdAt: "2026-09-24T00:01:00.000Z", storyId: "story-sam-1" },
    );
    assert.equal((await client.request("POST", "/api/contacts", JSON.stringify({
      id: "porch-alex", displayName: "Alex", address: "local:porch-alex/nextcloud-sim",
    }))).status, 201);
    assert.equal((await client.request("POST", "/api/contacts", JSON.stringify({
      id: "porch-sam", displayName: "Sam", address: "local:porch-sam/google-drive-sim",
    }))).status, 201);
    assert.equal((await client.request("POST", "/api/contacts", JSON.stringify({
      id: "remote-jo", displayName: "Jo", address: "https://10.0.0.5/jo",
    }))).status, 201);

    const timeline = await client.request("GET", "/api/timeline?backend=nextcloud-sim");
    assert.equal(timeline.status, 200);
    const body = timeline.json as {
      stories: { id: string; origin?: string }[];
      skipped: { porch?: string; id: string; reason: string }[];
    };
    assert.deepEqual(body.stories.map((s) => s.id), ["story-alex-1", "story-sam-1", "story-own-1"]);
    assert.equal(body.stories.find((s) => s.id === "story-own-1")?.origin, "nextcloud-sim");
    assert.equal(body.stories.find((s) => s.id === "story-alex-1")?.origin, "porch-alex");
    // M11 #90: private-range hosts are refused before any fetch.
    assert.ok(body.skipped.some((s) => s.porch === "remote-jo" && s.reason === "remote porch refused"));
    assert.ok(!JSON.stringify(timeline.json).includes(tmp), "timeline leaked a store path");

    const story = await client.request("GET", "/api/story?backend=nextcloud-sim&id=story-alex-1");
    assert.equal(story.status, 200);
    assert.equal((story.json as { body?: string }).body, "from alex");

    // M15 #100: each column reads its own porch's address book. The drive
    // porch follows nobody yet, so it shows none of the nextcloud follows...
    const drive = await client.request("GET", "/api/timeline?backend=google-drive-sim");
    assert.deepEqual((drive.json as { stories: { id: string }[] }).stories, []);
    // ...until its own contacts.json follows a porch.
    await addContact(new LocalFolderStore(join(tmp, "google-drive-sim")), validateContact({
      id: "kinfolk-alex", displayName: "Alex Rowan", address: "local:nextcloud-sim",
    }));
    const driveFollows = await client.request("GET", "/api/timeline?backend=google-drive-sim");
    const driveStories = (driveFollows.json as { stories: { id: string; origin?: string }[] }).stories;
    assert.deepEqual(driveStories.map((s) => [s.id, s.origin]), [["story-own-1", "kinfolk-alex"]]);
    const driveStory = await client.request("GET", "/api/story?backend=google-drive-sim&id=story-own-1");
    assert.equal((driveStory.json as { body?: string }).body, "mine");
    assert.equal((await client.request("GET", "/api/story?backend=google-drive-sim&id=story-alex-1")).status, 404,
      "the drive porch does not read through nextcloud's follows");
    assert.equal((await client.request("POST", "/api/open", JSON.stringify({ backend: "google-drive-sim", id: "story-alex-1" }))).status, 404);
    assert.equal((await client.request("POST", "/api/open", JSON.stringify({ backend: "google-drive-sim", id: "story-own-1" }))).status, 200);
    const driveContacts = await client.request("GET", "/api/contacts?backend=google-drive-sim");
    assert.deepEqual(((driveContacts.json as { contacts: { id: string }[] }).contacts).map((c) => c.id), ["kinfolk-alex"]);
    assert.equal((await client.request("GET", "/api/contacts?backend=other")).status, 400);

    await writeFile(join(tmp, "porch-sam/google-drive-sim/timeline/story-sam-1/story.json"), "{not json");
    const again = await client.request("GET", "/api/timeline?backend=nextcloud-sim");
    const againBody = again.json as { stories: { id: string }[]; skipped: { id: string; porch?: string }[] };
    assert.deepEqual(againBody.stories.map((s) => s.id), ["story-alex-1", "story-own-1"]);
    assert.ok(againBody.skipped.some((s) => s.id === "story-sam-1" && s.porch === "porch-sam"));
    assert.ok(!JSON.stringify(again.json).includes(tmp));
  } finally {
    if (savedIds === undefined) delete process.env.OWNPLACE_IDENTITY_DIR;
    else process.env.OWNPLACE_IDENTITY_DIR = savedIds;
    client.close();
    await rm(tmp, { recursive: true, force: true });
  }
});

test("web follow/unfollow round-trip keeps the porch address (#77)", async () => {
  const { client, tmp } = await boot();
  try {
    const added = await client.request("POST", "/api/contacts", JSON.stringify({
      id: "porch-alex", displayName: "Alex", address: "local:porch-alex/nextcloud-sim",
    }));
    assert.equal(added.status, 201);
    const listed = await client.request("GET", "/api/contacts");
    const contacts = ((listed.json ?? {}) as { contacts?: { id: string; address?: string }[] }).contacts ?? [];
    assert.equal(contacts.find((c) => c.id === "porch-alex")?.address, "local:porch-alex/nextcloud-sim");
    const removed = await client.request("DELETE", "/api/contacts?id=porch-alex");
    assert.equal(removed.status, 200);
    const after = await client.request("GET", "/api/contacts");
    const left = ((after.json ?? {}) as { contacts?: { id: string }[] }).contacts ?? [];
    assert.equal(left.some((c) => c.id === "porch-alex"), false);
  } finally {
    client.close();
    await rm(tmp, { recursive: true, force: true });
  }
});

test("public porch route serves only package files and round-trips to a follower (#90)", async () => {
  const { client, tmp } = await boot();
  const savedIds = process.env.OWNPLACE_IDENTITY_DIR;
  process.env.OWNPLACE_IDENTITY_DIR = join(tmp, "ids");
  const follower = await mkdtemp(resolve(tmpdir(), "rooted-follower-"));
  try {
    await publishStory(
      { title: "Served", body: "over the porch route", authorId: "kinfolk-me", authorName: "Me" },
      { root: tmp },
      { createdAt: "2026-09-28T00:00:00.000Z", storyId: "story-served-1" },
    );
    assert.equal((await client.request("POST", "/api/contacts", JSON.stringify({
      id: "porch-alex", displayName: "Alex", address: "local:porch-alex/nextcloud-sim",
    }))).status, 201);

    const hint = await client.request("GET", "/porch/nextcloud-sim/timeline.json");
    assert.equal(hint.status, 200);
    assert.ok(((hint.json as { stories: { id: string }[] }).stories).some((s) => s.id === "story-served-1"));
    for (const f of ["kinfolk.json", "story.json", "manifest.json", "signature.json"]) {
      assert.equal((await client.request("GET", `/porch/nextcloud-sim/timeline/story-served-1/${f}`)).status, 200, f);
    }
    for (const bad of [
      "/porch/nextcloud-sim/contacts.json",
      "/porch/nextcloud-sim/timeline/story-served-1/other.json",
      "/porch/nextcloud-sim/timeline/..%2F..%2Fcontacts.json/story.json",
      "/porch/nextcloud-sim/timeline/../contacts.json",
      "/porch/other-sim/timeline.json",
      "/porch/nextcloud-sim/timeline/nope/story.json",
      "/porch/nextcloud-sim/",
    ]) {
      const r = await client.request("GET", bad);
      assert.equal(r.status, 404, bad);
      assert.ok(!r.raw.includes("porch-alex"), `${bad} leaked contacts`);
    }
    assert.notEqual((await client.request("POST", "/porch/nextcloud-sim/timeline.json", "{}")).status, 200);

    // A second instance follows this porch over the real route.
    await addContact(new LocalFolderStore(join(follower, "nextcloud-sim")), validateContact({
      id: "me-remote", displayName: "Me", address: "https://porch.test/porch/nextcloud-sim",
    }));
    const viaRoute = async (url: string): Promise<Response> => {
      const r = await client.request("GET", url.replace("https://porch.test", ""));
      return new Response(r.raw, { status: r.status });
    };
    const merged = await readContactFollowedTimeline(follower, "nextcloud-sim", "2026-09-28T00:05:00.000Z", "nextcloud-sim", { fetch: viaRoute });
    assert.deepEqual(merged.stories.map((s) => [s.id, s.origin]), [["story-served-1", "me-remote"]]);
  } finally {
    if (savedIds === undefined) delete process.env.OWNPLACE_IDENTITY_DIR;
    else process.env.OWNPLACE_IDENTITY_DIR = savedIds;
    client.close();
    await rm(tmp, { recursive: true, force: true });
    await rm(follower, { recursive: true, force: true });
  }
});

test("invite routes are public-safe and follow-by-invite fails closed (#92)", async () => {
  const { client, tmp } = await boot();
  const savedIds = process.env.OWNPLACE_IDENTITY_DIR;
  process.env.OWNPLACE_IDENTITY_DIR = join(tmp, "ids");
  try {
    assert.equal((await client.request("GET", "/api/invite?backend=nextcloud-sim")).status, 404, "no invite before a signed post");
    await publishStory(
      { title: "Hi", body: "invite me", authorId: "kinfolk-rowan", authorName: "Rowan" },
      { root: tmp },
      { createdAt: "2026-09-28T00:00:00.000Z", storyId: "story-invite-1" },
    );
    const info = await client.request("GET", "/api/invite?backend=nextcloud-sim");
    assert.equal(info.status, 200);
    const { fingerprint, path, displayName } = info.json as { fingerprint: string; path: string; displayName: string };
    assert.match(fingerprint, /^[0-9a-f]{64}$/);
    assert.equal(path, `i/${fingerprint}`);
    assert.equal(displayName, "Rowan");
    assert.equal((await client.request("GET", "/api/invite?backend=other")).status, 400);

    const doc = await client.request("GET", `/i/${fingerprint}.json`);
    assert.equal(doc.status, 200);
    assert.deepEqual(doc.json, { protocol: "rooted/v0.1", kind: "invite", fingerprint, displayName: "Rowan", porch: "../porch/nextcloud-sim" });
    assert.ok(!doc.raw.includes(tmp), "invite leaked a store path");
    for (const bad of [`/i/${"0".repeat(64)}.json`, `/i/${fingerprint.toUpperCase()}.json`, "/i/abc.json", `/i/${fingerprint}x.json`]) {
      assert.equal((await client.request("GET", bad)).status, 404, bad);
    }
    // Landing page path is recognized (HTML when the bundle is built).
    assert.notEqual((await client.request("GET", `/i/${fingerprint}`)).status, 400);

    const follow = (invite: unknown) => client.request("POST", "/api/contacts/invite", JSON.stringify({ invite }));
    for (const [invite, msg] of [
      [`https://10.0.0.5/i/${fingerprint}`, "invite host refused"],
      [`http://porch.test/i/${fingerprint}`, "invite link must be https"],
      ["https://porch.test/not-an-invite", "not an OwnPlace invite link"],
    ] as const) {
      const r = await follow(invite);
      assert.equal(r.status, 400, invite);
      assert.equal((r.json as { error: string }).error, msg);
    }
    assert.equal((await follow(42)).status, 400);
    const contacts = ((await client.request("GET", "/api/contacts")).json as { contacts: unknown[] }).contacts;
    assert.equal(contacts.length, 0, "failed follows add nothing");
  } finally {
    if (savedIds === undefined) delete process.env.OWNPLACE_IDENTITY_DIR;
    else process.env.OWNPLACE_IDENTITY_DIR = savedIds;
    client.close();
    await rm(tmp, { recursive: true, force: true });
  }
});

// M14 #97: the creator's invite panel follows the signed identity when
// nextcloud-sim is gone, agreeing with the /i/ link.
test("/api/invite with no backend shows only the operator's invite; /i/ serves both (#97, #100)", async () => {
  const { client, tmp } = await boot();
  const savedIds = process.env.OWNPLACE_IDENTITY_DIR;
  process.env.OWNPLACE_IDENTITY_DIR = join(tmp, "ids");
  try {
    assert.equal((await client.request("GET", "/api/invite")).status, 404, "no invite before a signed post");
    // M15 #100: only Sam has posted. The operator (Alex) must not be handed
    // Sam's invite: the two porches are two different people.
    await publishStory(
      { title: "Hi", body: "sam's porch", authorId: "kinfolk-sam", authorName: "Sam" },
      { root: tmp },
      { createdAt: "2026-09-29T00:00:00.000Z", storyId: "story-invite-97" },
    );
    assert.equal((await client.request("GET", "/api/invite")).status, 404, "panel never shows the other Kinfolk's invite");
    const sam = await client.request("GET", "/api/invite?backend=google-drive-sim");
    assert.equal(sam.status, 200);
    const { fingerprint } = sam.json as { fingerprint: string };
    assert.ok(!sam.raw.includes(tmp), "invite leaked a store path");

    // Sam's own invite link still resolves to Sam's porch.
    const doc = await client.request("GET", `/i/${fingerprint}.json`);
    assert.equal(doc.status, 200);
    assert.equal((doc.json as { porch: string }).porch, "../porch/google-drive-sim");

    assert.equal((await client.request("GET", "/api/invite?backend=nextcloud-sim")).status, 404);
    assert.equal((await client.request("GET", "/api/invite?backend=other")).status, 400);

    // Once Alex posts, the panel shows Alex's invite; each link resolves to its own porch.
    await publishStory(
      { title: "Hi", body: "alex's porch", authorId: "kinfolk-alex", authorName: "Alex Rowan" },
      { root: tmp },
      { createdAt: "2026-09-29T00:01:00.000Z", storyId: "story-invite-97-alex" },
    );
    const info = await client.request("GET", "/api/invite");
    assert.equal(info.status, 200);
    const alex = info.json as { fingerprint: string; path: string };
    assert.equal(alex.fingerprint, ((await client.request("GET", "/api/invite?backend=nextcloud-sim")).json as { fingerprint: string }).fingerprint);
    assert.notEqual(alex.fingerprint, fingerprint);
    assert.equal(alex.path, `i/${alex.fingerprint}`);
    assert.equal(((await client.request("GET", `/i/${alex.fingerprint}.json`)).json as { porch: string }).porch, "../porch/nextcloud-sim");
    assert.equal(((await client.request("GET", `/i/${fingerprint}.json`)).json as { porch: string }).porch, "../porch/google-drive-sim");
  } finally {
    if (savedIds === undefined) delete process.env.OWNPLACE_IDENTITY_DIR;
    else process.env.OWNPLACE_IDENTITY_DIR = savedIds;
    client.close();
    await rm(tmp, { recursive: true, force: true });
  }
});

test("web composer posts as the logged-in Kinfolk only, to their porch only (#100)", async () => {
  const ids = await mkdtemp(resolve(tmpdir(), "rooted-web-ids-"));
  const { client, tmp } = await boot({ OWNPLACE_IDENTITY_DIR: ids });
  try {
    for (const body of [
      { title: "t", body: "b", authorId: "kinfolk-sam" },
      { title: "t", body: "b", authorId: "kinfolk-bob" },
      { title: "t", body: "b", authorName: "Somebody Else" },
    ]) {
      assertError(await client.request("POST", "/api/post", JSON.stringify(body)), 400, {
        error: "can only post as the logged-in Kinfolk",
      });
    }
    const posted = await client.request("POST", "/api/post", JSON.stringify({ title: "Mine", body: "as alex" }));
    assert.equal(posted.status, 201);
    const result = posted.json as { authorId: string; backends: string[]; storyId: string };
    assert.equal(result.authorId, "kinfolk-alex");
    assert.deepEqual(result.backends, ["nextcloud-sim"]);
    const nextcloud = await client.request("GET", "/api/timeline?backend=nextcloud-sim");
    assert.deepEqual((nextcloud.json as { stories: { id: string }[] }).stories.map((s) => s.id), [result.storyId]);
    const drive = await client.request("GET", "/api/timeline?backend=google-drive-sim");
    assert.deepEqual((drive.json as { stories: unknown[] }).stories, [], "no mirror to Sam's porch");
  } finally {
    client.close();
    await rm(tmp, { recursive: true, force: true });
    await rm(ids, { recursive: true, force: true });
  }
});
