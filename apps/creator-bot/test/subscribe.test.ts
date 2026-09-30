import test from "node:test";
import assert from "node:assert/strict";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { generateKeyPairSync } from "node:crypto";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { DEMO_KINFOLK } from "@rooted/timeline";
const run = promisify(execFile);

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const subscribeEntry = resolve(repoRoot, "apps/creator-bot/src/subscribe.ts");

async function runSubscribe(tmp: string, args: string[]) {
  const env: Record<string, string | undefined> = { ...process.env, PUBLISH_ROOT: tmp };
  delete env.KEVCLOUD_WEBDAV_URL;
  delete env.KEVCLOUD_WEBDAV_USER;
  delete env.KEVCLOUD_WEBDAV_PASS;
  delete env.GOOGLE_DRIVE_SYNC;
  return run(process.execPath, ["--import", "tsx", subscribeEntry, ...args], {
    cwd: repoRoot,
    env: env as NodeJS.ProcessEnv,
  });
}

async function readerPubkey(tmp: string): Promise<string> {
  const file = join(tmp, "reader-a.pub");
  const pub = generateKeyPairSync("x25519").publicKey.export({ type: "spki", format: "pem" }).toString();
  await writeFile(file, pub);
  return file;
}

// M16 #108: each direction, the subscriber lands on the chosen Kinfolk's
// porch and the other Kinfolk's porch is never created.
for (const kinfolk of DEMO_KINFOLK) {
  test(`subscribe --author-id ${kinfolk.id} writes ${kinfolk.porch} only (#108)`, async () => {
    const tmp = await mkdtemp(join(tmpdir(), "rooted-subscribe-"));
    try {
      const pubkey = await readerPubkey(tmp);
      const { stdout } = await runSubscribe(tmp,
        ["--author-id", kinfolk.id, "--reader-id", "reader-a", "--reader-pubkey", pubkey]);
      assert.match(stdout, new RegExp(`subscribed reader-a to ${kinfolk.id} on ${kinfolk.porch}`));
      const list = JSON.parse(await readFile(join(tmp, kinfolk.porch, "subscribers.json"), "utf8"));
      assert.deepStrictEqual(list.subscribers.map((s: { readerId: string }) => s.readerId), ["reader-a"]);
      for (const other of DEMO_KINFOLK.filter((k) => k.porch !== kinfolk.porch)) {
        await assert.rejects(access(join(tmp, other.porch)), `${other.id}'s porch must be untouched`);
      }
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });
}

test("subscribe with a missing or unknown --author-id exits 2 and writes nothing (#108)", async () => {
  const tmp = await mkdtemp(join(tmpdir(), "rooted-subscribe-"));
  try {
    const pubkey = await readerPubkey(tmp);
    await assert.rejects(
      runSubscribe(tmp, ["--reader-id", "reader-a", "--reader-pubkey", pubkey]),
      (e: { code?: number; stderr?: string }) => e.code === 2 && /need --author-id/.test(e.stderr ?? ""),
    );
    await assert.rejects(
      runSubscribe(tmp, ["--author-id", "--reader-id", "reader-a", "--reader-pubkey", pubkey]),
      (e: { code?: number }) => e.code === 2,
    );
    await assert.rejects(
      runSubscribe(tmp, ["--author-id", "kinfolk-bob", "--reader-id", "reader-a", "--reader-pubkey", pubkey]),
      (e: { code?: number; stderr?: string }) => e.code === 2 && /author has no porch in this demo/.test(e.stderr ?? ""),
    );
    for (const k of DEMO_KINFOLK) {
      await assert.rejects(access(join(tmp, k.porch)), `a refused subscribe writes nothing (${k.porch})`);
    }
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

// M15 #111: on a copy whose operator is Jordan, Jordan owns the operator's
// porch and Alex is not a Kinfolk there.
test("subscribe allows the OWNPLACE_OPERATOR_* Kinfolk and refuses Alex (#111)", async () => {
  const tmp = await mkdtemp(join(tmpdir(), "rooted-subscribe-"));
  const subscribe = (args: string[]) => run(process.execPath, ["--import", "tsx", subscribeEntry, ...args], {
    cwd: repoRoot,
    env: { ...process.env, PUBLISH_ROOT: tmp, OWNPLACE_OPERATOR_ID: "kinfolk-jordan" } as NodeJS.ProcessEnv,
  });
  try {
    const pubkey = await readerPubkey(tmp);
    await assert.rejects(
      subscribe(["--author-id", "kinfolk-alex", "--reader-id", "reader-a", "--reader-pubkey", pubkey]),
      (e: { code?: number; stderr?: string }) => e.code === 2 && /author has no porch in this demo/.test(e.stderr ?? ""),
    );
    await assert.rejects(access(join(tmp, "nextcloud-sim")), "a refused subscribe writes nothing");
    const { stdout } = await subscribe(["--author-id", "kinfolk-jordan", "--reader-id", "reader-a", "--reader-pubkey", pubkey]);
    assert.match(stdout, /subscribed reader-a to kinfolk-jordan on nextcloud-sim/);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});
