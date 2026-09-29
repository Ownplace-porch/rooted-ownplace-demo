import test from "node:test";
import assert from "node:assert/strict";
import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import { identityFingerprint } from "@rooted/protocol";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
const run = promisify(execFile);

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const publishEntry = "apps/creator-bot/src/index.ts";
const postEntry = "apps/creator-bot/src/post.ts";

function cleanEnv(tmp: string): NodeJS.ProcessEnv {
  const env: Record<string, string | undefined> = { ...process.env, PUBLISH_ROOT: tmp };
  // Hermetic: ambient cloud credentials must not leak into the child or skew
  // assertions (CI runners may export KEVCLOUD_* / GOOGLE_DRIVE_SYNC).
  delete env.KEVCLOUD_WEBDAV_URL;
  delete env.KEVCLOUD_WEBDAV_USER;
  delete env.KEVCLOUD_WEBDAV_PASS;
  delete env.GOOGLE_DRIVE_SYNC;
  return env as NodeJS.ProcessEnv;
}

async function readJson(...parts: string[]) {
  return JSON.parse(await readFile(join(...parts), "utf8"));
}

test("publisher seeds two Kinfolk, one porch each, following each other (#100)", async () => {
  const tmp = await mkdtemp(join(tmpdir(), "rooted-publish-"));
  const env = { ...cleanEnv(tmp), OWNPLACE_IDENTITY_DIR: join(tmp, "ids") };
  try {
    await run(process.execPath, ["--import", "tsx", publishEntry], { cwd: repoRoot, env });
    const alex = await readJson(tmp, "nextcloud-sim", "kinfolk.json");
    const sam = await readJson(tmp, "google-drive-sim", "kinfolk.json");
    assert.equal(alex.id, "kinfolk-alex");
    assert.equal(alex.bio, "Building a more rooted internet.");
    assert.equal(sam.id, "kinfolk-sam");
    assert.notEqual(alex.publicKey, sam.publicKey, "two Kinfolk, two keys");
    // Each story lives on its author's porch only.
    assert.equal((await readJson(tmp, "nextcloud-sim", "timeline", "story-first-light", "story.json")).authorId, "kinfolk-alex");
    assert.equal((await readJson(tmp, "google-drive-sim", "timeline", "story-garden-table", "story.json")).authorId, "kinfolk-sam");
    await assert.rejects(access(join(tmp, "nextcloud-sim", "timeline", "story-garden-table")));
    await assert.rejects(access(join(tmp, "google-drive-sim", "timeline", "story-first-light")));
    // Each follows the other at a local: address, pinned to the other's key.
    const alexFollows = (await readJson(tmp, "nextcloud-sim", "contacts.json")).contacts;
    const samFollows = (await readJson(tmp, "google-drive-sim", "contacts.json")).contacts;
    assert.deepEqual(alexFollows.map((c: { id: string; address: string }) => [c.id, c.address]), [["kinfolk-sam", "local:google-drive-sim"]]);
    assert.deepEqual(samFollows.map((c: { id: string; address: string }) => [c.id, c.address]), [["kinfolk-alex", "local:nextcloud-sim"]]);
    assert.equal(alexFollows[0].fingerprint, identityFingerprint(sam.publicKey));
    assert.equal(samFollows[0].fingerprint, identityFingerprint(alex.publicKey));

    // Re-running is idempotent: same bytes, no duplicate follows.
    const before = await readFile(join(tmp, "google-drive-sim", "timeline", "story-garden-table", "signature.json"));
    await run(process.execPath, ["--import", "tsx", publishEntry], { cwd: repoRoot, env });
    assert.deepStrictEqual(await readFile(join(tmp, "google-drive-sim", "timeline", "story-garden-table", "signature.json")), before);
    assert.equal((await readJson(tmp, "nextcloud-sim", "contacts.json")).contacts.length, 1);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test("publisher preserves timeline history across a publish cycle (#41)", async () => {
  // Regression: legacy `npm run publish` used to rm -rf each backend dir,
  // deleting timeline/ history accumulated by `npm run post` (timeline 404).
  const tmp = await mkdtemp(join(tmpdir(), "rooted-publish-"));
  try {
    // 1. Accumulate timeline history via `post` (same lane the web write API uses).
    const { stdout } = await run(
      process.execPath,
      ["--import", "tsx", postEntry, "--title", "Keep me", "--body", "history must survive"],
      { cwd: repoRoot, env: cleanEnv(tmp) }
    );
    const id = (stdout.match(/story=\S+/) ?? [""])[0].replace("story=", "").trim();
    assert.ok(id, `expected story id in post output, got: ${String(stdout).slice(-200)}`);
    // 2. Run the legacy seed publisher over the same root.
    await run(process.execPath, ["--import", "tsx", publishEntry], {
      cwd: repoRoot,
      env: cleanEnv(tmp),
    });
    // 3. Timeline history survives on Alex's porch (the post's author).
    for (const backend of ["nextcloud-sim"]) {
      const kept = JSON.parse(await readFile(join(tmp, backend, "timeline", id, "story.json"), "utf8"));
      assert.equal(kept.title, "Keep me");
      const index = JSON.parse(await readFile(join(tmp, backend, "timeline.json"), "utf8"));
      assert.ok(
        index.stories.some((s: { id: string }) => s.id === id),
        `${backend} index missing ${id}`
      );
    }
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});
