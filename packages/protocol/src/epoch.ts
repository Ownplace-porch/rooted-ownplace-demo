// M16 #116: encrypted-by-default posts (slice 1 of #115).
//
// Demo-grade confidentiality like gated.ts, NOT audited cryptography:
// - Each author holds one random 256-bit epoch key, stored next to their
//   identity files (never published). Every encrypted post seals its
//   content (title, body, createdAt, media, to / inReplyTo) with it using
//   AES-256-GCM, bound to the author id and story id as associated data.
// - The epoch key is wrapped to each reader's X25519 key with the same
//   per-wrap ephemeral construction as sealed bodies (gated.ts wrapDataKey).
//   The wrap file names NO reader: no id, fingerprint or public key. Readers
//   trial-decrypt every wrap (fine for small N) and wraps are shuffled, so
//   order says nothing either. The number of wraps does show how many
//   readers there are.
// - The ciphertext sits inside the signed story.json, so Ed25519 still
//   covers it: tampering fails verification before any decryption.
// - The wrap file is unsigned. A swapped wrap can only hand a reader a key
//   that fails the GCM check on signed ciphertext, so it fails closed.

import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { GATED_ALGORITHM, isSafeReaderId, parseKeyWrap, unwrapDataKey, wrapDataKey, type KeyWrap } from "./gated.js";

export const ENCRYPTED_CONTENT_VERSION = 1;
export const KEYS_FILE = "keys.json";
const AAD_LABEL = "ownplace-story-v1";
const EPOCH_KEY_BYTES = 32;
const NONCE_BYTES = 12;
const GCM_TAG_BYTES = 16;
const MAX_CIPHERTEXT_B64 = 262144;
const MAX_EPOCHS = 64;
const MAX_WRAPS = 256;
const B64_RE = /^[A-Za-z0-9+/]+={0,2}$/;
const EPOCH_ID_RE = /^[0-9a-f]{32}$/;

export interface EpochKey {
  epoch: string;
  key: Buffer;
}

export interface EncryptedContent {
  v: typeof ENCRYPTED_CONTENT_VERSION;
  algorithm: typeof GATED_ALGORITHM;
  epoch: string;
  nonce: string;
  ciphertext: string;
}

export interface EpochWraps {
  epoch: string;
  wraps: KeyWrap[];
}

export interface KeysFile {
  protocol: "rooted/v0.1";
  kind: "keys";
  epochs: EpochWraps[];
}

function identityDir(): string {
  return process.env.OWNPLACE_IDENTITY_DIR ?? join(homedir(), ".local", "share", "ownplace", "identities");
}

function parseEpochKey(text: string): EpochKey {
  const doc = JSON.parse(text) as { epoch?: unknown; key?: unknown };
  if (typeof doc.epoch !== "string" || !EPOCH_ID_RE.test(doc.epoch) || typeof doc.key !== "string" || !B64_RE.test(doc.key)) {
    throw new Error("epoch key file is malformed");
  }
  const key = Buffer.from(doc.key, "base64");
  if (key.length !== EPOCH_KEY_BYTES) throw new Error("epoch key file is malformed");
  return { epoch: doc.epoch, key };
}

// Slice 1 has one epoch per author. A new epoch on removal is slice 2.
export function loadOrCreateEpochKey(authorId: string, directory = identityDir()): EpochKey {
  if (!isSafeReaderId(authorId)) throw new Error("unsafe Kinfolk id");
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const path = join(directory, `${authorId}.epoch.json`);
  try {
    return parseEpochKey(readFileSync(path, "utf8"));
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
  }
  const fresh = { epoch: randomBytes(16).toString("hex"), key: randomBytes(EPOCH_KEY_BYTES).toString("base64") };
  try {
    writeFileSync(path, `${JSON.stringify(fresh)}\n`, { mode: 0o600, flag: "wx" });
  } catch (writeError) {
    if ((writeError as NodeJS.ErrnoException).code !== "EEXIST") throw writeError;
  }
  return parseEpochKey(readFileSync(path, "utf8"));
}

function shuffle<T>(items: T[]): T[] {
  for (let i = items.length - 1; i > 0; i--) {
    const j = randomBytes(4).readUInt32BE(0) % (i + 1);
    [items[i], items[j]] = [items[j], items[i]];
  }
  return items;
}

// One wrap per distinct reader key, in random order, naming nobody.
export function wrapEpochKey(epochKey: EpochKey, readerPublicKeys: string[]): EpochWraps {
  const distinct = [...new Set(readerPublicKeys.map((k) => k.trim()))];
  if (distinct.length === 0) throw new Error("at least one reader required");
  if (distinct.length > MAX_WRAPS) throw new Error("too many readers");
  return { epoch: epochKey.epoch, wraps: shuffle(distinct.map((pem) => wrapDataKey(epochKey.key, pem))) };
}

export function buildKeysFile(epochs: EpochWraps[]): KeysFile {
  return { protocol: "rooted/v0.1", kind: "keys", epochs };
}

function aad(authorId: string, storyId: string): Buffer {
  return Buffer.from(`${AAD_LABEL}\n${authorId}\n${storyId}`, "utf8");
}

export function encryptContent(plaintext: string, epochKey: EpochKey, authorId: string, storyId: string): EncryptedContent {
  if (typeof plaintext !== "string" || plaintext.length === 0) throw new Error("content must be non-empty");
  const nonce = randomBytes(NONCE_BYTES);
  const cipher = createCipheriv(GATED_ALGORITHM, epochKey.key, nonce);
  cipher.setAAD(aad(authorId, storyId));
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final(), cipher.getAuthTag()]);
  return {
    v: ENCRYPTED_CONTENT_VERSION,
    algorithm: GATED_ALGORITHM,
    epoch: epochKey.epoch,
    nonce: nonce.toString("base64"),
    ciphertext: ciphertext.toString("base64"),
  };
}

export function isEncryptedContent(value: unknown): value is EncryptedContent {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const env = value as Record<string, unknown>;
  if (Object.keys(env).length !== 5) return false;
  if (env.v !== ENCRYPTED_CONTENT_VERSION || env.algorithm !== GATED_ALGORITHM) return false;
  if (typeof env.epoch !== "string" || !EPOCH_ID_RE.test(env.epoch)) return false;
  if (typeof env.nonce !== "string" || !B64_RE.test(env.nonce) || Buffer.from(env.nonce, "base64").length !== NONCE_BYTES) return false;
  if (typeof env.ciphertext !== "string" || env.ciphertext.length > MAX_CIPHERTEXT_B64 || !B64_RE.test(env.ciphertext)) return false;
  return Buffer.from(env.ciphertext, "base64").length > GCM_TAG_BYTES;
}

// Throws "cannot decrypt" for a wrong key or tampered bytes. Callers show
// fixed strings only, never crypto internals.
export function decryptContent(env: EncryptedContent, key: Buffer, authorId: string, storyId: string): string {
  if (!isEncryptedContent(env)) throw new Error("encrypted content is malformed");
  try {
    const ct = Buffer.from(env.ciphertext, "base64");
    const decipher = createDecipheriv(GATED_ALGORITHM, key, Buffer.from(env.nonce, "base64"));
    decipher.setAAD(aad(authorId, storyId));
    decipher.setAuthTag(ct.subarray(ct.length - GCM_TAG_BYTES));
    return Buffer.concat([decipher.update(ct.subarray(0, ct.length - GCM_TAG_BYTES)), decipher.final()]).toString("utf8");
  } catch {
    throw new Error("cannot decrypt");
  }
}

// Finds the reader's wrap for one epoch in an untrusted keys.json value.
// Returns undefined when the file is malformed, names no such epoch, or no
// wrap opens with this key: all mean "not a reader" to the caller.
export function unwrapEpochKey(keysFile: unknown, epoch: string, readerPrivateKeyPem: string): Buffer | undefined {
  if (!keysFile || typeof keysFile !== "object") return undefined;
  const epochs = (keysFile as { kind?: unknown; epochs?: unknown }).epochs;
  if ((keysFile as { kind?: unknown }).kind !== "keys" || !Array.isArray(epochs) || epochs.length > MAX_EPOCHS) return undefined;
  const entry = epochs.find((e) => (e as { epoch?: unknown } | null)?.epoch === epoch) as { wraps?: unknown } | undefined;
  if (!entry || !Array.isArray(entry.wraps) || entry.wraps.length > MAX_WRAPS) return undefined;
  const wraps: KeyWrap[] = [];
  for (const w of entry.wraps) {
    try {
      wraps.push(parseKeyWrap(w));
    } catch {
      // A malformed wrap is skipped; the others may still open.
    }
  }
  return unwrapDataKey(wraps, readerPrivateKeyPem);
}
