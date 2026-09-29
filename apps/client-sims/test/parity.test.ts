import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, cp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { verifyParity } from "../src/verify-parity.js";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

test("verifyParity passes on fresh sims without cloud env", async () => {
  // Fresh-checkout proof: seed the sims first (CI starts from an empty tree
  // since demo/stores/*/ is gitignored). Seeding here keeps the test
  // self-contained instead of depending on test order or prior publish.
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const runLocal = promisify(execFile);
  await runLocal(process.execPath, ["--import", "tsx", "apps/creator-bot/src/index.ts"], {
    cwd: repoRoot,
    env: { ...process.env, PUBLISH_ROOT: undefined, KEVCLOUD_WEBDAV_URL: "", GOOGLE_DRIVE_SYNC: "" },
  });
  const saved = { ...process.env };
  delete process.env.KEVCLOUD_WEBDAV_URL;
  delete process.env.KEVCLOUD_WEBDAV_USER;
  delete process.env.KEVCLOUD_WEBDAV_PASS;
  delete process.env.GOOGLE_DRIVE_SYNC;
  try {
    const report = await verifyParity();
    assert.equal(report.ok, true);
    assert.ok(report.backends.includes("nextcloud-sim"));
    assert.ok(report.backends.includes("google-drive-sim"));
    // M15 #100: two Kinfolk, so the sims are never expected to match.
    assert.notEqual(report.fingerprints["nextcloud-sim"], report.fingerprints["google-drive-sim"]);
    assert.deepStrictEqual(report.problems, []);
  } finally {
    process.env = saved;
  }
});

test("verifyParity reports sim drift as ok:false (no throw)", async () => {
  // Isolated overlay: copy sims to temp, tamper the copy, point parity at it.
  const tmp = await mkdtemp(join(tmpdir(), "rooted-parity-"));
  try {
    await cp(join(repoRoot, "demo/stores/nextcloud-sim"), join(tmp, "nextcloud-sim"), { recursive: true });
    await cp(join(repoRoot, "demo/stores/google-drive-sim"), join(tmp, "google-drive-sim"), { recursive: true });
    const { readFile, writeFile } = await import("node:fs/promises");
    const victim = join(tmp, "google-drive-sim/story.json");
    const story = JSON.parse((await readFile(victim)).toString());
    await writeFile(victim, JSON.stringify({ ...story, body: "tampered" }));
    const savedEnv = process.env.PUBLISH_ROOT;
    const savedCloud = { ...process.env };
    delete process.env.KEVCLOUD_WEBDAV_URL;
    delete process.env.GOOGLE_DRIVE_SYNC;
    process.env.PUBLISH_ROOT = tmp;
    try {
      const report = await verifyParity();
      assert.equal(report.ok, false);
      assert.ok(report.problems.some((p) => p.includes("google-drive-sim")),
        `expected google-drive-sim problem, got: ${report.problems.join(";")}`);
    } finally {
      if (savedEnv === undefined) delete process.env.PUBLISH_ROOT;
      else process.env.PUBLISH_ROOT = savedEnv;
      Object.assign(process.env, savedCloud);
    }
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
  // Real checkout untouched: parity clean again.
  const healed = await verifyParity();
  assert.equal(healed.ok, true);
});
