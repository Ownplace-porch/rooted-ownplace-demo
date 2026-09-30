// Sealed story bodies for multi-reader paid gating (slice 2).
//
// Demo-grade end-to-end confidentiality, NOT audited cryptography:
// - Random 256-bit data key per story; body sealed once with AES-256-GCM.
// - SAME data key wrapped per entitled reader via X25519 ECDH (NaCl-box style
//   construction from Node primitives: fresh ephemeral keypair PER READER,
//   SHA-256 KDF, AES-256-GCM wrap). Fresh ephemeral per reader is chosen for
//   hygiene: compromising one wrap's ephemeral does not help open other
//   readers' entries, at the cost of a slightly larger envelope.
// - Kinfolk keys stay separated by purpose: Ed25519 signs (identity, see
//   index.ts), X25519 decrypts (confidentiality). Never mix the two.
// - The envelope lives INSIDE story.json, so the manifest hash plus Ed25519
//   signature bind it: stripping, swapping, or downgrading it invalidates
//   the package for verifying readers.
// - Gated stories publish the SAME bytes to every backend, so cross-backend
//   parity still holds. Per-reader package variants (and per-audience
//   parity) are an explicitly later slice.

import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createPrivateKey,
  createPublicKey,
  diffieHellman,
  generateKeyPairSync,
  randomBytes,
  type KeyObject,
} from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const GATED_ALGORITHM = "aes-256-gcm";
const KDF_LABEL = "ownplace-gated-v1";
const BODY_NONCE_BYTES = 12;
const KEY_NONCE_BYTES = 12;
const DATA_KEY_BYTES = 32;
const GCM_TAG_BYTES = 16;
const MAX_PLAINTEXT_BYTES = 8192;
const MAX_B64_CHARS = 65536;
const B64_RE = /^[A-Za-z0-9+/]+={0,2}$/;

export interface WrappedReaderKey {
  readerId: string;
  ephemeralPublicKey: string;
  keyNonce: string;
  wrappedKey: string;
}

export interface SealedBody {
  algorithm: typeof GATED_ALGORITHM;
  bodyNonce: string;
  ciphertext: string;
  wrapped: WrappedReaderKey[];
}

/** One entitled reader: compatible with timeline EntitleReader. */
export interface SealReader {
  readerId: string;
  readerPublicKey: string;
}

export type OpenResult =
  | { status: "public"; body: string }
  | { status: "opened"; body: string; media: string[] }
  | { status: "restricted" }
  | { status: "not-entitled" }
  | { status: "unreadable" };

export const MAX_MEDIA_ITEMS = 8;
export const MAX_MEDIA_URL_CHARS = 2048;

// Media lives in poster Drive/Nextcloud folders fetched over TLS (#58),
// so only https pointers seal. Anything else is rejected, never stored.
// Canonical home (mediagated.ts re-exports these); kept here so the open
// path can enforce the same contract without a gated<->mediagated cycle.
export function isMediaList(value: unknown): value is string[] {
  return (
    Array.isArray(value) &&
    value.length <= MAX_MEDIA_ITEMS &&
    value.every(
      (u): u is string =>
        typeof u === "string" &&
        u.length >= 9 &&
        u.length <= MAX_MEDIA_URL_CHARS &&
        u.startsWith("https://"),
    )
  );
}

export function isSafeReaderId(id: unknown): id is string {
  return (
    typeof id === "string" &&
    /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(id) &&
    !id.includes("..")
  );
}

function toB64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64");
}

function fromB64(value: unknown, expectedBytes?: number): Buffer {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > MAX_B64_CHARS ||
    !B64_RE.test(value)
  ) {
    throw new Error("gated envelope is malformed");
  }
  const buf = Buffer.from(value, "base64");
  if (expectedBytes !== undefined && buf.length !== expectedBytes) {
    throw new Error("gated envelope is malformed");
  }
  return buf;
}

function loadX25519Public(pem: string, what: string): KeyObject {
  let key: KeyObject;
  try {
    key = createPublicKey(pem);
  } catch {
    throw new Error(`${what} is not a readable public key`);
  }
  if (key.asymmetricKeyType !== "x25519") throw new Error(`${what} must be X25519`);
  return key;
}

function loadX25519Private(pem: string, what: string): KeyObject {
  let key: KeyObject;
  try {
    key = createPrivateKey(pem);
  } catch {
    throw new Error(`${what} is not a readable private key`);
  }
  if (key.asymmetricKeyType !== "x25519") throw new Error(`${what} must be X25519`);
  return key;
}

function rawPublicBytes(key: KeyObject): Buffer {
  return Buffer.from((key.export({ format: "jwk" }) as { x: string }).x, "base64url");
}

function deriveKek(shared: Buffer, ephemeralRaw: Buffer, readerRaw: Buffer): Buffer {
  return createHash("sha256")
    .update(KDF_LABEL, "utf8")
    .update(shared)
    .update(ephemeralRaw)
    .update(readerRaw)
    .digest();
}

// The X25519 private key stays on the reader machine next to the Ed25519
// identity file. The published encryption public key is self-asserted, same
// trust level as the signing key: pin it before relying on it over time.
export function loadOrCreateEncryptionIdentity(
  id: string,
  directory = process.env.OWNPLACE_IDENTITY_DIR ?? join(homedir(), ".local", "share", "ownplace", "identities"),
): { privateKey: string; publicKey: string } {
  if (!isSafeReaderId(id)) throw new Error("unsafe Kinfolk id");
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const path = join(directory, `${id}.enc.pem`);
  let privateKey: string;
  try {
    privateKey = readFileSync(path, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    const pair = generateKeyPairSync("x25519");
    privateKey = pair.privateKey.export({ type: "pkcs8", format: "pem" }).toString();
    try {
      writeFileSync(path, privateKey, { mode: 0o600, flag: "wx" });
    } catch (writeError) {
      if ((writeError as NodeJS.ErrnoException).code !== "EEXIST") throw writeError;
      privateKey = readFileSync(path, "utf8");
    }
  }
  const key = loadX25519Private(privateKey, "Kinfolk encryption key");
  const publicKey = createPublicKey(key).export({ type: "spki", format: "pem" }).toString();
  return { privateKey, publicKey };
}

// One key wrap: the data key sealed to one reader's X25519 key with a
// fresh ephemeral keypair. It names no reader. M16 #116: shared by sealed
// bodies (below, which add a readerId) and author epoch keys (epoch.ts,
// which must not).
export interface KeyWrap {
  ephemeralPublicKey: string;
  keyNonce: string;
  wrappedKey: string;
}

export function wrapDataKey(dataKey: Uint8Array, readerPublicKeyPem: string): KeyWrap {
  if (dataKey.length !== DATA_KEY_BYTES) throw new Error("data key must be 32 bytes");
  const readerPublic = loadX25519Public(readerPublicKeyPem, "reader public key");
  const ephemeral = generateKeyPairSync("x25519");
  const ephemeralPublic = ephemeral.publicKey;
  const shared = diffieHellman({ privateKey: ephemeral.privateKey, publicKey: readerPublic });
  const kek = deriveKek(shared, rawPublicBytes(ephemeralPublic), rawPublicBytes(readerPublic));
  const keyNonce = randomBytes(KEY_NONCE_BYTES);
  const keyCipher = createCipheriv(GATED_ALGORITHM, kek, keyNonce);
  const wrappedKey = Buffer.concat([keyCipher.update(dataKey), keyCipher.final(), keyCipher.getAuthTag()]);
  return {
    ephemeralPublicKey: ephemeralPublic.export({ type: "spki", format: "pem" }).toString(),
    keyNonce: toB64(keyNonce),
    wrappedKey: toB64(wrappedKey),
  };
}

function unwrapWithKey(wrap: KeyWrap, readerPrivate: KeyObject, readerRaw: Buffer): Buffer {
  const ephemeralPublic = loadX25519Public(wrap.ephemeralPublicKey, "ephemeral key");
  const shared = diffieHellman({ privateKey: readerPrivate, publicKey: ephemeralPublic });
  const kek = deriveKek(shared, rawPublicBytes(ephemeralPublic), readerRaw);
  const wrappedKey = fromB64(wrap.wrappedKey);
  const keyDecipher = createDecipheriv(GATED_ALGORITHM, kek, fromB64(wrap.keyNonce, KEY_NONCE_BYTES));
  keyDecipher.setAuthTag(wrappedKey.subarray(DATA_KEY_BYTES));
  return Buffer.concat([
    keyDecipher.update(wrappedKey.subarray(0, DATA_KEY_BYTES)),
    keyDecipher.final(),
  ]);
}

// Shape check for a wrap with no reader id; throws "gated envelope is
// malformed" like the sealed-body parser.
export function parseKeyWrap(value: unknown): KeyWrap {
  if (!value || typeof value !== "object") throw new Error("gated envelope is malformed");
  const wrap = value as Record<string, unknown>;
  if (typeof wrap.ephemeralPublicKey !== "string" || wrap.ephemeralPublicKey.length === 0 || wrap.ephemeralPublicKey.length > MAX_B64_CHARS) {
    throw new Error("gated envelope is malformed");
  }
  fromB64(wrap.keyNonce, KEY_NONCE_BYTES);
  if (fromB64(wrap.wrappedKey).length !== DATA_KEY_BYTES + GCM_TAG_BYTES) throw new Error("gated envelope is malformed");
  loadX25519Public(wrap.ephemeralPublicKey, "ephemeral key");
  return { ephemeralPublicKey: wrap.ephemeralPublicKey, keyNonce: wrap.keyNonce as string, wrappedKey: wrap.wrappedKey as string };
}

// Trial-decrypts each wrap with the reader's key; returns the data key from
// the first that opens, or undefined. Shape errors in a wrap skip it.
export function unwrapDataKey(wraps: readonly KeyWrap[], readerPrivateKeyPem: string): Buffer | undefined {
  const readerPrivate = loadX25519Private(readerPrivateKeyPem, "reader encryption key");
  const readerRaw = rawPublicBytes(createPublicKey(readerPrivate));
  for (const wrap of wraps) {
    try {
      return unwrapWithKey(wrap, readerPrivate, readerRaw);
    } catch {
      continue;
    }
  }
  return undefined;
}

export function isEncryptionPublicKey(value: unknown): value is string {
  if (typeof value !== "string" || value.length === 0 || value.length > MAX_B64_CHARS) return false;
  try {
    loadX25519Public(value, "encryption key");
    return true;
  } catch {
    return false;
  }
}

export function sealBodyForReaders(
  plaintext: string,
  readers: SealReader[],
): SealedBody {
  if (!Array.isArray(readers) || readers.length === 0) throw new Error("at least one reader required");
  const seen = new Set<string>();
  for (const r of readers) {
    if (!r || !isSafeReaderId(r.readerId)) throw new Error("unsafe reader id");
    if (seen.has(r.readerId)) throw new Error("duplicate reader id");
    seen.add(r.readerId);
    loadX25519Public(r.readerPublicKey, "reader public key");
  }
  if (typeof plaintext !== "string" || plaintext.length === 0) throw new Error("body must be non-empty");
  const plainBytes = new TextEncoder().encode(plaintext);
  if (plainBytes.length > MAX_PLAINTEXT_BYTES) throw new Error("body too large to seal");
  const dataKey = randomBytes(DATA_KEY_BYTES);
  const bodyNonce = randomBytes(BODY_NONCE_BYTES);
  const bodyCipher = createCipheriv(GATED_ALGORITHM, dataKey, bodyNonce);
  const ciphertext = Buffer.concat([bodyCipher.update(plainBytes), bodyCipher.final(), bodyCipher.getAuthTag()]);
  const wrapped: WrappedReaderKey[] = [];
  try {
    for (const r of readers) {
      wrapped.push({ readerId: r.readerId, ...wrapDataKey(dataKey, r.readerPublicKey) });
    }
  } finally {
    dataKey.fill(0);
  }
  return {
    algorithm: GATED_ALGORITHM,
    bodyNonce: toB64(bodyNonce),
    ciphertext: toB64(ciphertext),
    wrapped,
  };
}

export function sealBody(plaintext: string, readerPublicKeyPem: string, readerId: string): SealedBody {
  return sealBodyForReaders(plaintext, [{ readerId, readerPublicKey: readerPublicKeyPem }]);
}

function parseWrappedEntry(value: unknown): WrappedReaderKey {
  if (!value || typeof value !== "object") throw new Error("gated envelope is malformed");
  const wrapped = value as Record<string, unknown>;
  if (!isSafeReaderId(wrapped.readerId)) throw new Error("gated envelope is malformed");
  if (typeof wrapped.ephemeralPublicKey !== "string" || wrapped.ephemeralPublicKey.length === 0 || wrapped.ephemeralPublicKey.length > MAX_B64_CHARS) {
    throw new Error("gated envelope is malformed");
  }
  for (const v of [wrapped.keyNonce, wrapped.wrappedKey]) {
    if (typeof v !== "string" || v.length === 0 || v.length > MAX_B64_CHARS || !B64_RE.test(v)) {
      throw new Error("gated envelope is malformed");
    }
  }
  fromB64(wrapped.keyNonce, KEY_NONCE_BYTES);
  const wk = fromB64(wrapped.wrappedKey);
  if (wk.length !== DATA_KEY_BYTES + GCM_TAG_BYTES) throw new Error("gated envelope is malformed");
  loadX25519Public(wrapped.ephemeralPublicKey, "ephemeral key");
  return value as WrappedReaderKey;
}

function parseEnvelope(envelope: unknown): SealedBody {
  if (!envelope || typeof envelope !== "object") throw new Error("gated envelope is malformed");
  const env = envelope as Record<string, unknown>;
  if (env.algorithm !== GATED_ALGORITHM) throw new Error("gated envelope is malformed");
  if (!Array.isArray(env.wrapped) || env.wrapped.length === 0) throw new Error("gated envelope is malformed");
  const wrapped = env.wrapped.map(parseWrappedEntry);
  fromB64(env.bodyNonce, BODY_NONCE_BYTES);
  const ct = fromB64(env.ciphertext);
  if (ct.length < GCM_TAG_BYTES + 1) throw new Error("gated envelope is malformed");
  return envelope as SealedBody;
}

export function isSealedBody(value: unknown): value is SealedBody {
  try {
    parseEnvelope(value);
    return true;
  } catch {
    return false;
  }
}

// Shape errors throw "gated envelope is malformed" (author or packaging bug
// inside a signed package). Key failures throw "not entitled to this story".
// Callers must present fixed UI strings for both, never crypto internals.
export function unsealBody(envelope: unknown, readerPrivateKeyPem: string, readerId?: string): string {
  const env = parseEnvelope(envelope);
  if (readerId !== undefined && !env.wrapped.some((e) => e.readerId === readerId)) {
    throw new Error("not entitled to this story");
  }
  const readerPrivate = loadX25519Private(readerPrivateKeyPem, "reader encryption key");
  const readerRaw = rawPublicBytes(createPublicKey(readerPrivate));
  const candidates =
    readerId !== undefined ? env.wrapped.filter((e) => e.readerId === readerId) : env.wrapped;
  for (const entry of candidates) {
    let dataKey: Buffer | undefined;
    try {
      dataKey = unwrapWithKey(entry, readerPrivate, readerRaw);
      const bodyDecipher = createDecipheriv(GATED_ALGORITHM, dataKey, fromB64(env.bodyNonce, BODY_NONCE_BYTES));
      const ct = fromB64(env.ciphertext);
      bodyDecipher.setAuthTag(ct.subarray(ct.length - GCM_TAG_BYTES));
      const plain = Buffer.concat([
        bodyDecipher.update(ct.subarray(0, ct.length - GCM_TAG_BYTES)),
        bodyDecipher.final(),
      ]);
      const out = new TextDecoder().decode(plain);
      dataKey.fill(0);
      return out;
    } catch (e) {
      if (dataKey) dataKey.fill(0);
      if (e instanceof Error && e.message === "gated envelope is malformed") throw e;
      continue;
    }
  }
  throw new Error("not entitled to this story");
}

// Display helper: fixed statuses, never crypto internals. A gated story
// carrying a non-empty plaintext body fails closed ("unreadable") — the
// verify path rejects such packages outright (see timeline).
export function tryOpenBody(
  story: { body?: unknown; restricted?: unknown },
  readerPrivateKey?: string,
  readerId?: string,
): OpenResult {
  if (story.restricted === undefined) {
    return typeof story.body === "string" ? { status: "public", body: story.body } : { status: "unreadable" };
  }
  if (story.body !== "" || !isSealedBody(story.restricted)) return { status: "unreadable" };
  if (readerPrivateKey === undefined) return { status: "restricted" };
  try {
    const plaintext = unsealBody(story.restricted, readerPrivateKey, readerId);
    // M8 #65: v1 gated-content envelope carries sealed media alongside the
    // body (canonical shape in mediagated.ts; parsed inline here to avoid a
    // gated<->mediagated import cycle). Legacy bare-string envelopes open
    // with empty media so pre-media packages keep working.
    // Envelope sniffing matches merged #64 openGatedContent: only
    // sealGatedContent writes v1 envelopes, so a legacy bare string opens
    // as-is unless it carries the exact v1 shape (requires an author to
    // have sealed that exact JSON — accepted, demo-grade per mediagated).
    // A v1-shaped envelope whose media violates the seal contract fails
    // closed: renderers must never trust unbounded/author-crafted URLs.
    // Only JSON.parse throws here (legacy sealed string body); the shape
    // checks below are pure and fail closed to the legacy path.
    let parsed: unknown = null;
    try {
      parsed = JSON.parse(plaintext);
    } catch {
      // Not JSON: legacy sealed string body.
    }
    let body = plaintext;
    let media: string[] = [];
    if (
      parsed !== null && typeof parsed === "object" && !Array.isArray(parsed) &&
      (parsed as { v?: unknown }).v === 1 &&
      typeof (parsed as { body?: unknown }).body === "string" &&
      Object.hasOwn(parsed, "media")
    ) {
      const m = (parsed as { media?: unknown }).media;
      if (!isMediaList(m)) return { status: "unreadable" };
      body = ((parsed as unknown) as { body: string }).body;
      media = m;
    }
    return { status: "opened", body, media };
  } catch (e) {
    return e instanceof Error && e.message === "gated envelope is malformed"
      ? { status: "unreadable" }
      : { status: "not-entitled" };
  }
}
