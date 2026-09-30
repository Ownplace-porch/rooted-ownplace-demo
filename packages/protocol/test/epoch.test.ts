import test from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildKeysFile,
  decryptContent,
  encryptContent,
  loadOrCreateEpochKey,
  unwrapEpochKey,
  wrapEpochKey,
} from "../src/index.js";

// M16 #116: author epoch keys, id-free key wraps, and story encryption.

function x25519() {
  const pair = generateKeyPairSync("x25519");
  return {
    priv: pair.privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
    pub: pair.publicKey.export({ type: "spki", format: "pem" }).toString(),
  };
}

async function withDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "rooted-epoch-"));
  try {
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("epoch key is created once, kept private, and reused", async () => {
  await withDir(async (dir) => {
    const first = loadOrCreateEpochKey("kinfolk-alex", dir);
    const again = loadOrCreateEpochKey("kinfolk-alex", dir);
    assert.equal(first.epoch, again.epoch);
    assert.deepEqual(first.key, again.key);
    assert.equal(first.key.length, 32);
    assert.match(first.epoch, /^[0-9a-f]{32}$/);
    assert.notEqual(loadOrCreateEpochKey("kinfolk-sam", dir).epoch, first.epoch, "one epoch key per author");
    if (process.platform !== "win32") {
      assert.equal((await stat(join(dir, "kinfolk-alex.epoch.json"))).mode & 0o777, 0o600);
    }
    assert.throws(() => loadOrCreateEpochKey("../evil", dir), /unsafe Kinfolk id/);
  });
});

test("content opens only with the epoch key, for the same author and story", async () => {
  await withDir(async (dir) => {
    const epoch = loadOrCreateEpochKey("kinfolk-alex", dir);
    const env = encryptContent('{"title":"Secret supper"}', epoch, "kinfolk-alex", "story-1");
    assert.ok(!JSON.stringify(env).includes("Secret"), "ciphertext only");
    assert.equal(decryptContent(env, epoch.key, "kinfolk-alex", "story-1"), '{"title":"Secret supper"}');
    const other = loadOrCreateEpochKey("kinfolk-sam", dir);
    assert.throws(() => decryptContent(env, other.key, "kinfolk-alex", "story-1"), /cannot decrypt/);
    // Associated data binds the author and story id: a moved ciphertext fails.
    assert.throws(() => decryptContent(env, epoch.key, "kinfolk-alex", "story-2"), /cannot decrypt/);
    assert.throws(() => decryptContent(env, epoch.key, "kinfolk-sam", "story-1"), /cannot decrypt/);
  });
});

test("a tampered ciphertext is rejected by the GCM tag", async () => {
  await withDir(async (dir) => {
    const epoch = loadOrCreateEpochKey("kinfolk-alex", dir);
    const env = encryptContent("hello kinfolk", epoch, "kinfolk-alex", "story-1");
    const bytes = Buffer.from(env.ciphertext, "base64");
    bytes[0] ^= 0x01;
    const tampered = { ...env, ciphertext: bytes.toString("base64") };
    assert.throws(() => decryptContent(tampered, epoch.key, "kinfolk-alex", "story-1"), /cannot decrypt/);
    assert.throws(() => decryptContent({ ...env, v: 2 } as never, epoch.key, "kinfolk-alex", "story-1"), /malformed/);
  });
});

test("key wraps name no reader and open only for the readers they were made for", async () => {
  await withDir(async (dir) => {
    const epoch = loadOrCreateEpochKey("kinfolk-alex", dir);
    const alex = x25519();
    const sam = x25519();
    const stranger = x25519();
    const file = buildKeysFile([wrapEpochKey(epoch, [alex.pub, sam.pub, sam.pub])]);
    const text = JSON.stringify(file);
    assert.equal(file.epochs[0].wraps.length, 2, "one wrap per distinct reader key");
    for (const wrap of file.epochs[0].wraps) {
      assert.deepEqual(Object.keys(wrap).sort(), ["ephemeralPublicKey", "keyNonce", "wrappedKey"]);
    }
    for (const pub of [alex.pub, sam.pub]) {
      const body = pub.split("\n").filter((l) => l && !l.startsWith("-----")).join("");
      assert.ok(!text.includes(body), "no reader public key in the wrap file");
    }
    assert.deepEqual(unwrapEpochKey(file, epoch.epoch, alex.priv), epoch.key);
    assert.deepEqual(unwrapEpochKey(file, epoch.epoch, sam.priv), epoch.key);
    assert.equal(unwrapEpochKey(file, epoch.epoch, stranger.priv), undefined);
    assert.equal(unwrapEpochKey(file, "0".repeat(32), sam.priv), undefined, "unknown epoch");
    assert.equal(unwrapEpochKey({ kind: "other", epochs: file.epochs }, epoch.epoch, sam.priv), undefined);
    assert.equal(unwrapEpochKey(null, epoch.epoch, sam.priv), undefined);
    // A malformed wrap is skipped; the reader's own wrap still opens.
    const noisy = buildKeysFile([{ epoch: epoch.epoch, wraps: [{ junk: true } as never, ...file.epochs[0].wraps] }]);
    assert.deepEqual(unwrapEpochKey(noisy, epoch.epoch, sam.priv), epoch.key);
    assert.throws(() => wrapEpochKey(epoch, []), /at least one reader/);
    assert.ok((await readFile(join(dir, "kinfolk-alex.epoch.json"), "utf8")).length > 0);
  });
});
