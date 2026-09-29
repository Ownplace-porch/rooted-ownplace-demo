import test from "node:test";
import assert from "node:assert/strict";
import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
const run = promisify(execFile);

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const postEntry = resolve(repoRoot, "apps/creator-bot/src/post.ts");

async function runPost(tmp: string, args: string[], extraEnv: Record<string, string> = {}) {
  const env: Record<string, string | undefined> = { ...process.env, PUBLISH_ROOT: tmp, ...extraEnv };
  // Hermetic: ambient cloud credentials must not leak into the child or skew
  // assertions (CI runners may export KEVCLOUD_* / GOOGLE_DRIVE_SYNC).
  delete env.KEVCLOUD_WEBDAV_URL;
  delete env.KEVCLOUD_WEBDAV_USER;
  delete env.KEVCLOUD_WEBDAV_PASS;
  delete env.GOOGLE_DRIVE_SYNC;
  return run(process.execPath, ["--import", "tsx", postEntry, ...args], {
    cwd: repoRoot,
    env: env as NodeJS.ProcessEnv,
  });
}

async function readJson(tmp: string, backend: string, ...parts: string[]) {
  return JSON.parse(await readFile(join(tmp, backend, ...parts), "utf8"));
}

test("post publishes the timeline story to Alex's porch only (#100)", async () => {
  const tmp = await mkdtemp(join(tmpdir(), "rooted-post-"));
  try {
    const { stdout } = await runPost(tmp, ["--title", "Hello timeline", "--body", "First syndicated post"]);
    const id = (stdout.match(/story=\S+/) ?? [""])[0].replace("story=", "").trim();
    assert.ok(id.startsWith("story-"), `expected story id in output, got: ${stdout.slice(-200)}`);
    await assert.rejects(access(join(tmp, "google-drive-sim")), "Alex's post must not mirror to Sam's porch");
    for (const backend of ["nextcloud-sim"]) {
      for (const f of ["kinfolk.json", "story.json", "manifest.json", "signature.json"]) {
        assert.ok((await readFile(join(tmp, backend, "timeline", id, f))).length > 0, `${backend}/${f} missing`);
      }
      const index = await readJson(tmp, backend, "timeline.json");
      assert.ok(index.stories.some((s: { id: string }) => s.id === id), `${backend} index missing ${id}`);
      // flat latest copy matches timeline copy
      for (const f of ["story.json", "manifest.json"]) {
        const flat = await readFile(join(tmp, backend, f));
        const tl = await readFile(join(tmp, backend, "timeline", id, f));
        assert.deepStrictEqual(flat, tl, `${backend} flat ${f} != timeline copy`);
      }
    }
    const story = await readJson(tmp, "nextcloud-sim", "timeline", id, "story.json");
    assert.equal(story.title, "Hello timeline");
    assert.equal(story.body, "First syndicated post");
    assert.equal(story.authorId, "kinfolk-alex");
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test("post accumulates timeline across two posts", async () => {
  const tmp = await mkdtemp(join(tmpdir(), "rooted-post-"));
  try {
    await runPost(tmp, ["--title", "One", "--body", "first"]);
    await runPost(tmp, ["--title", "Two", "--body", "second"]);
    const index = await readJson(tmp, "nextcloud-sim", "timeline.json");
    assert.equal(index.stories.length, 2);
    assert.equal(index.stories[0].title, "Two"); // newest first
    assert.equal(index.stories[1].title, "One");
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test("post rejects missing/oversize input without writing", async () => {
  const tmp = await mkdtemp(join(tmpdir(), "rooted-post-"));
  try {
    await assert.rejects(() => runPost(tmp, ["--title", "", "--body", "x"]));
    await assert.rejects(() => runPost(tmp, ["--title", "T"]));
    await assert.rejects(() => runPost(tmp, ["--title", "--body", "x"])); // flag-swallowing guard
    await assert.rejects(() => runPost(tmp, ["--title", "x".repeat(141), "--body", "ok"]));
    await assert.rejects(() => runPost(tmp, ["--title", "ok", "--body", "x".repeat(5001)]));
    const { access } = await import("node:fs/promises");
    for (const backend of ["nextcloud-sim", "google-drive-sim"]) {
      const missing = await access(join(tmp, backend)).then(() => false, () => true);
      assert.equal(missing, true, `nothing should be written on validation failure (${backend})`);
    }
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test("post rebuilds corrupt timeline index from on-disk history", async () => {
  const tmp = await mkdtemp(join(tmpdir(), "rooted-post-"));
  const { writeFile } = await import("node:fs/promises");
  try {
    await runPost(tmp, ["--title", "Keep me", "--body", "history survives"]);
    await writeFile(join(tmp, "nextcloud-sim", "timeline.json"), "{corrupt-index");
    const { stdout } = await runPost(tmp, ["--title", "Second", "--body", "after corruption"]);
    assert.match(stdout, /rebuilt nextcloud-sim index from 1 on-disk story/);
    const index = JSON.parse(await readFile(join(tmp, "nextcloud-sim", "timeline.json"), "utf8"));
    assert.equal(index.stories.length, 2);
    const titles = index.stories.map((s: { title: string }) => s.title).sort();
    assert.deepStrictEqual(titles, ["Keep me", "Second"]);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test("post --entitle-readers seals for N readers on the author's porch", async () => {
  const tmp = await mkdtemp(join(tmpdir(), "rooted-post-"));
  const { generateKeyPairSync } = await import("node:crypto");
  const { writeFile } = await import("node:fs/promises");
  const { tryOpenBody } = await import("@rooted/protocol");
  const idsDir = await mkdtemp(join(tmpdir(), "rooted-post-ids-"));
  function x25519Pair() {
    const pair = generateKeyPairSync("x25519");
    return {
      priv: pair.privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
      pub: pair.publicKey.export({ type: "spki", format: "pem" }).toString(),
    };
  }
  try {
    const a = x25519Pair();
    const b = x25519Pair();
    const c = x25519Pair();
    await writeFile(join(tmp, "reader-a.pub"), a.pub);
    await writeFile(join(tmp, "reader-b.pub"), b.pub);
    // Mix both supported shapes: pubkeyFile paths and one inline publicKey.
    const batchFile = join(tmp, "readers.json");
    await writeFile(batchFile, JSON.stringify([
      { readerId: "reader-a", pubkeyFile: join(tmp, "reader-a.pub") },
      { readerId: "reader-b", pubkeyFile: join(tmp, "reader-b.pub") },
      { readerId: "reader-c", publicKey: c.pub },
    ]));
    const savedIds = process.env.OWNPLACE_IDENTITY_DIR;
    process.env.OWNPLACE_IDENTITY_DIR = idsDir;
    let stdout: string;
    try {
      ({ stdout } = await runPost(tmp,
        ["--title", "Paid post", "--body", "paywalled words", "--entitle-readers", batchFile]));
    } finally {
      if (savedIds === undefined) delete process.env.OWNPLACE_IDENTITY_DIR;
      else process.env.OWNPLACE_IDENTITY_DIR = savedIds;
    }
    const id = (stdout.match(/story=\S+/) ?? [""])[0].replace("story=", "").trim();
    assert.ok(id.startsWith("story-"), `expected story id in output, got: ${stdout.slice(-200)}`);
    const packageFiles = ["kinfolk.json", "story.json", "manifest.json", "signature.json", "entitlements.json"];
    await assert.rejects(access(join(tmp, "google-drive-sim")), "Alex's post must not mirror to Sam's porch");
    for (const backend of ["nextcloud-sim"]) {
      for (const f of packageFiles) {
        assert.ok((await readFile(join(tmp, backend, "timeline", id, f))).length > 0, `${backend}/${f} missing`);
      }
      // Flat latest copy matches timeline copy (sidecar included).
      for (const f of ["story.json", "manifest.json", "entitlements.json"]) {
        const flat = await readFile(join(tmp, backend, f));
        const tl = await readFile(join(tmp, backend, "timeline", id, f));
        assert.deepStrictEqual(flat, tl, `${backend} flat ${f} != timeline copy`);
      }
    }
    const story = await readJson(tmp, "nextcloud-sim", "timeline", id, "story.json");
    assert.equal(story.body, "");
    assert.equal(story.restricted.wrapped.length, 3);
    const entitlements = await readJson(tmp, "nextcloud-sim", "timeline", id, "entitlements.json");
    assert.equal(entitlements.storyId, id);
    assert.deepStrictEqual(entitlements.entitled,
      [{ readerId: "reader-a" }, { readerId: "reader-b" }, { readerId: "reader-c" }]);
    // Every entitled reader opens the sealed body; anonymous stays restricted.
    for (const [pair, readerId] of [[a, "reader-a"], [b, "reader-b"], [c, "reader-c"]] as const) {
      const opened = tryOpenBody(story, pair.priv, readerId);
      assert.equal(opened.status, "opened");
      assert.equal((opened as { body: string }).body, "paywalled words");
    }
    assert.equal(tryOpenBody(story).status, "restricted");
  } finally {
    await rm(tmp, { recursive: true, force: true });
    await rm(idsDir, { recursive: true, force: true });
  }
});

test("post --entitle-readers combines with legacy flags and rejects misuse with exit 2", async () => {
  const tmp = await mkdtemp(join(tmpdir(), "rooted-post-"));
  const { generateKeyPairSync } = await import("node:crypto");
  const { writeFile } = await import("node:fs/promises");
  function x25519Pair() {
    const pair = generateKeyPairSync("x25519");
    return pair.publicKey.export({ type: "spki", format: "pem" }).toString();
  }
  async function exitCode(args: string[]): Promise<number | null> {
    try {
      await runPost(tmp, args);
    } catch (e) {
      return (e as { code?: number | null }).code ?? null;
    }
    return null;
  }
  try {
    const pubA = x25519Pair();
    const pubB = x25519Pair();
    await writeFile(join(tmp, "reader-a.pub"), pubA);
    await writeFile(join(tmp, "reader-b.pub"), pubB);
    // Combined legacy + batch: 2 wrapped keys, 2 entitled ids.
    const idsDir = await mkdtemp(join(tmpdir(), "rooted-post-ids-"));
    const batchFile = join(tmp, "readers.json");
    await writeFile(batchFile, JSON.stringify([{ readerId: "reader-b", pubkeyFile: join(tmp, "reader-b.pub") }]));
    const savedIds = process.env.OWNPLACE_IDENTITY_DIR;
    process.env.OWNPLACE_IDENTITY_DIR = idsDir;
    try {
      const { stdout } = await runPost(tmp, ["--title", "Paid", "--body", "words",
        "--entitle-reader", "reader-a", "--reader-pubkey", join(tmp, "reader-a.pub"),
        "--entitle-readers", batchFile]);
      const id = (stdout.match(/story=\S+/) ?? [""])[0].replace("story=", "").trim();
      const story = await readJson(tmp, "nextcloud-sim", "timeline", id, "story.json");
      assert.equal(story.restricted.wrapped.length, 2);
      const entitlements = await readJson(tmp, "nextcloud-sim", "timeline", id, "entitlements.json");
      assert.deepStrictEqual(entitlements.entitled, [{ readerId: "reader-b" }, { readerId: "reader-a" }]);
    } finally {
      if (savedIds === undefined) delete process.env.OWNPLACE_IDENTITY_DIR;
      else process.env.OWNPLACE_IDENTITY_DIR = savedIds;
      await rm(idsDir, { recursive: true, force: true });
    }
    // Misuse: every case must fail with usage error exit 2.
    const badJson = join(tmp, "bad.json");
    await writeFile(badJson, "{not-json");
    assert.equal(await exitCode(["--title", "T", "--body", "B", "--entitle-readers", badJson]), 2);
    const emptyArr = join(tmp, "empty.json");
    await writeFile(emptyArr, "[]");
    assert.equal(await exitCode(["--title", "T", "--body", "B", "--entitle-readers", emptyArr]), 2);
    const nonArr = join(tmp, "nonarr.json");
    await writeFile(nonArr, '{"readerId":"x"}');
    assert.equal(await exitCode(["--title", "T", "--body", "B", "--entitle-readers", nonArr]), 2);
    const unsafeId = join(tmp, "unsafe.json");
    await writeFile(unsafeId, JSON.stringify([{ readerId: "../evil", publicKey: pubA }]));
    assert.equal(await exitCode(["--title", "T", "--body", "B", "--entitle-readers", unsafeId]), 2);
    const missingKey = join(tmp, "missing-pubkey.json");
    await writeFile(missingKey, JSON.stringify([{ readerId: "reader-a", pubkeyFile: join(tmp, "nope.pub") }]));
    assert.equal(await exitCode(["--title", "T", "--body", "B", "--entitle-readers", missingKey]), 2);
    const noKey = join(tmp, "no-key.json");
    await writeFile(noKey, JSON.stringify([{ readerId: "reader-a" }]));
    assert.equal(await exitCode(["--title", "T", "--body", "B", "--entitle-readers", noKey]), 2);
    const dupes = join(tmp, "dupes.json");
    await writeFile(dupes, JSON.stringify([
      { readerId: "reader-a", publicKey: pubA },
      { readerId: "reader-a", publicKey: pubB },
    ]));
    assert.equal(await exitCode(["--title", "T", "--body", "B", "--entitle-readers", dupes]), 2);
    assert.equal(await exitCode(["--title", "T", "--body", "B", "--entitle-readers", join(tmp, "absent.json")]), 2);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test("post --author-id kinfolk-sam lands on Sam's porch; other authors are refused (#100)", async () => {
  const tmp = await mkdtemp(join(tmpdir(), "rooted-post-"));
  const idsDir = join(tmp, "ids");
  try {
    const { stdout } = await runPost(tmp, ["--title", "From Sam", "--body", "on the drive porch", "--author-id", "kinfolk-sam"],
      { OWNPLACE_IDENTITY_DIR: idsDir });
    const id = (stdout.match(/story=\S+/) ?? [""])[0].replace("story=", "").trim();
    assert.match(stdout, /done: google-drive-sim /);
    const story = await readJson(tmp, "google-drive-sim", "timeline", id, "story.json");
    assert.equal(story.authorId, "kinfolk-sam");
    const kinfolk = await readJson(tmp, "google-drive-sim", "timeline", id, "kinfolk.json");
    assert.equal(kinfolk.displayName, "Sam");
    await assert.rejects(access(join(tmp, "nextcloud-sim")), "Sam's post must not mirror to Alex's porch");

    await assert.rejects(
      runPost(tmp, ["--title", "t", "--body", "b", "--author-id", "kinfolk-bob"], { OWNPLACE_IDENTITY_DIR: idsDir }),
      (e: { code?: number; stderr?: string }) => e.code === 2 && /author has no porch in this demo/.test(e.stderr ?? ""),
    );
    await assert.rejects(access(join(tmp, "nextcloud-sim")), "a refused post writes nothing");
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

// M15 #111: the CLIs default to, and allow, the OWNPLACE_OPERATOR_* Kinfolk.
test("post and delete-reply use the OWNPLACE_OPERATOR_* Kinfolk; Alex is refused (#111)", async () => {
  const tmp = await mkdtemp(join(tmpdir(), "rooted-post-"));
  const jordan = { OWNPLACE_IDENTITY_DIR: join(tmp, "ids"), OWNPLACE_OPERATOR_ID: "kinfolk-jordan", OWNPLACE_OPERATOR_NAME: "Jordan" };
  try {
    const { stdout } = await runPost(tmp, ["--title", "From Jordan", "--body", "on the operator porch"], jordan);
    assert.match(stdout, /done: nextcloud-sim .*author=kinfolk-jordan/);
    const id = (stdout.match(/story=\S+/) ?? [""])[0].replace("story=", "").trim();
    assert.equal((await readJson(tmp, "nextcloud-sim", "timeline", id, "kinfolk.json")).displayName, "Jordan");
    await assert.rejects(
      runPost(tmp, ["--title", "t", "--body", "b", "--author-id", "kinfolk-alex"], jordan),
      (e: { code?: number; stderr?: string }) => e.code === 2 && /author has no porch in this demo/.test(e.stderr ?? ""),
    );
    // delete-reply defaults to Jordan (the plain post is found, then refused
    // as not a reply) and refuses Alex, who has no porch on this copy.
    const deleteReply = (args: string[]) => run(process.execPath, ["--import", "tsx", resolve(repoRoot, "apps/creator-bot/src/delete.ts"), ...args], {
      cwd: repoRoot, env: { ...process.env, PUBLISH_ROOT: tmp, ...jordan } as NodeJS.ProcessEnv,
    });
    await assert.rejects(deleteReply(["--id", id]),
      (e: { code?: number; stderr?: string }) => e.code === 2 && /only comments and wall posts can be deleted/.test(e.stderr ?? ""));
    await assert.rejects(deleteReply(["--author-id", "kinfolk-alex", "--id", id]),
      (e: { code?: number; stderr?: string }) => e.code === 2 && /author has no porch in this demo/.test(e.stderr ?? ""));
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test("post refuses to start with an invalid OWNPLACE_OPERATOR_ID and writes nothing (#111)", async () => {
  const tmp = await mkdtemp(join(tmpdir(), "rooted-post-"));
  try {
    for (const id of ["../alex", "kinfolk-sam", ""]) {
      await assert.rejects(
        runPost(tmp, ["--title", "t", "--body", "b"], { OWNPLACE_IDENTITY_DIR: join(tmp, "ids"), OWNPLACE_OPERATOR_ID: id }),
        (e: { code?: number; stderr?: string }) => e.code === 2 &&
          (e.stderr ?? "").trim() === "refusing to start: OWNPLACE_OPERATOR_ID must be a valid Kinfolk id other than kinfolk-sam",
      );
    }
    await assert.rejects(access(join(tmp, "nextcloud-sim")), "a refused start writes nothing");
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});
