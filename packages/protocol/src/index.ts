import type { SealedBody } from "./gated.js";
import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, sign, verify } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export type Kinfolk = { id: string; displayName: string; bio?: string; publicKey?: string };
export type Story = { id: string; title: string; body: string; media: string[]; authorId: string; createdAt: string; restricted?: SealedBody };
export type ManifestObject = { path: string; sha256: string; contentType: string };
export type Manifest = { protocolVersion: "0.1"; packageId: string; objects: ManifestObject[]; signing: "demo-placeholder" | "ed25519" };
export type Signature = { algorithm: "demo-placeholder"; signedManifestSha256: string; note: string } | { algorithm: "ed25519"; signedManifestSha256: string; value: string };

export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const entries = Object.keys(value as Record<string, unknown>).sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson((value as Record<string, unknown>)[key])}`)
    .join(",");
  return `{${entries}}`;
}

export function sha256(value: string | Uint8Array): string { return createHash("sha256").update(value).digest("hex"); }
export function objectBytes(value: unknown): Uint8Array { return new TextEncoder().encode(`${canonicalJson(value)}\n`); }
export function hashObject(value: unknown): string { return sha256(objectBytes(value)); }

export function createManifest(packageId: string, objects: Array<Omit<ManifestObject, "sha256"> & { value: unknown }>, signing: Manifest["signing"] = "demo-placeholder"): Manifest {
  return {
    protocolVersion: "0.1", packageId, signing,
    objects: objects.map(({ path, contentType, value }) => ({ path, contentType, sha256: hashObject(value) }))
  };
}

// The private key stays on the publisher machine. The published public key is
// self-asserted; clients must pin it before treating it as a known identity.
export function loadOrCreateIdentity(id: string, directory = process.env.OWNPLACE_IDENTITY_DIR ?? join(homedir(), ".local", "share", "ownplace", "identities")): { privateKey: string; publicKey: string } {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(id) || id.includes("..")) throw new Error("unsafe Kinfolk id");
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const path = join(directory, `${id}.pem`);
  let privateKey: string;
  try {
    privateKey = readFileSync(path, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    const pair = generateKeyPairSync("ed25519");
    privateKey = pair.privateKey.export({ type: "pkcs8", format: "pem" }).toString();
    // Exclusive creation prevents two publishers from silently replacing a key.
    try { writeFileSync(path, privateKey, { mode: 0o600, flag: "wx" }); }
    catch (writeError) {
      if ((writeError as NodeJS.ErrnoException).code !== "EEXIST") throw writeError;
      privateKey = readFileSync(path, "utf8");
    }
  }
  const key = createPrivateKey(privateKey);
  if (key.asymmetricKeyType !== "ed25519") throw new Error("Kinfolk private key must be Ed25519");
  const publicKey = createPublicKey(key).export({ type: "spki", format: "pem" }).toString();
  return { privateKey, publicKey };
}

// M12 #92: canonical creator id. Lowercase hex SHA-256 of the Ed25519
// public key (SPKI DER). Stable across storage moves; reveals no location.
export function identityFingerprint(publicKeyPem: string): string {
  const key = createPublicKey(publicKeyPem);
  if (key.asymmetricKeyType !== "ed25519") throw new Error("identity key must be Ed25519");
  return sha256(key.export({ type: "spki", format: "der" }));
}

export function isFingerprint(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
}

export function signManifest(manifest: Manifest, privateKey: string): Signature {
  const key = createPrivateKey(privateKey);
  if (key.asymmetricKeyType !== "ed25519") throw new Error("Kinfolk private key must be Ed25519");
  return { algorithm: "ed25519", signedManifestSha256: hashObject(manifest), value: sign(null, objectBytes(manifest), key).toString("base64") };
}

export function verifyManifestSignature(manifest: unknown, signature: unknown, kinfolk: unknown): boolean {
  if (!manifest || typeof manifest !== "object" || !signature || typeof signature !== "object") return false;
  const m = manifest as Manifest;
  const sig = signature as Partial<Signature>;
  const person = kinfolk as Partial<Kinfolk> | null;
  if (m.signing !== "ed25519" || sig.algorithm !== "ed25519" || typeof sig.signedManifestSha256 !== "string" || typeof sig.value !== "string" || typeof person?.publicKey !== "string") return false;
  if (sig.signedManifestSha256 !== hashObject(m) || !/^[A-Za-z0-9+/]+={0,2}$/.test(sig.value)) return false;
  try {
    const key = createPublicKey(person.publicKey);
    return key.asymmetricKeyType === "ed25519" && verify(null, objectBytes(m), key, Buffer.from(sig.value, "base64"));
  }
  catch { return false; }
}
export * from "./gated.js";
export * from "./mediagated.js";
