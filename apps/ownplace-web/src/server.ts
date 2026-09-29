// OwnPlace write API: serves the built web UI and exposes JSON endpoints.
// Reads serve local sims (static demo). Writes go through @rooted/timeline
// — the SAME lane as the CLI. M15 #100: each sim is one Kinfolk's porch;
// the logged-in operator is OPERATOR_KINFOLK and posts to their porch only.
//
// Endpoints:
//   GET  /api/timeline?backend=nextcloud-sim        porch owner + porches it follows,
//                                                   comments and wall posts attached (M15 #101)
//   GET  /api/story?backend=B&id=ID                 verified history story
//   POST /api/open  {backend?, id, readerKey, readerId?}  open sealed body+media
//   GET  /api/contacts?backend=B                    that porch's contact list
//   POST /api/post        {title, body}  (as the operator Kinfolk only)
//   POST /api/post        {body, inReplyTo: {fingerprint, storyId}} | {body, to: {fingerprint}}
//   DELETE /api/post?id=ID                          operator deletes own comment/wall post
//   POST /api/hidden      {fingerprint, storyId}    operator hides a reply aimed at them
//   POST /api/contacts    {id, displayName, address}  |  DELETE /api/contacts?id=ID
//
// Write auth: single-operator demo token via OWNPLACE_WRITE_TOKEN env.
// Login mints an HttpOnly session cookie (Secure on HTTPS: forced via
// COOKIE_SECURE=1 or auto-detected from X-Forwarded-Proto / TLS);
// Bearer tokens are also accepted. POST/DELETE get 401 without auth;
// reads stay public. When the env var is unset, writes are allowed locally
// with a console warning (dev convenience, not a claim).

import { randomBytes } from "node:crypto";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readFile } from "node:fs/promises";
import {
  addContact,
  backendsFromEnv,
  checkReplyTarget,
  deleteReply,
  DELETE_REFUSED,
  hideableReply,
  hideReply,
  isReplyTarget,
  readThreadedTimeline,
  defaultRepoRoot,
  demoKinfolkFor,
  isSafeHistoryId,
  OPERATOR_KINFOLK,
  isSafeReaderId,
  requireOperatorSettings,
  publishStory,
  readVerifiedFollowedStory,
  buildInviteDocument,
  porchIdentity,
  resolveInvite,
  INVITE_PATH,
  readContacts,
  readVerifiedHistoryStory,
  removeContact,
  tryOpenStory,
  validateContact,
  validateInput,
} from "@rooted/timeline";
import { LocalFolderStore, PORCH_PACKAGE_FILES } from "@rooted/storage";

// M15 #111: invalid OWNPLACE_OPERATOR_* settings refuse startup.
requireOperatorSettings();

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = defaultRepoRoot();
const distDir = path.resolve(repoRoot, "apps/ownplace-web/dist"); // server lives in apps/ownplace-web/src/
const port = Number(process.env.PORT ?? 8091);
const writeToken = process.env.OWNPLACE_WRITE_TOKEN ?? "";

if (!writeToken) {
  console.warn("OWNPLACE_WRITE_TOKEN unset: write endpoints are open (local dev mode)");
}

// Single shared stores root for reads AND writes (backendsFromEnv):
// with PUBLISH_ROOT set, API reads see what API/CLI writes, not stale data.
const storesRoot = backendsFromEnv(repoRoot).root;

// M15 #100: the operator's own porch holds the contacts the operator edits.
const operator = demoKinfolkFor(OPERATOR_KINFOLK)!;
const operatorPorch = operator.porch;

function simStore(backend: string): LocalFolderStore {
  if (backend !== "nextcloud-sim" && backend !== "google-drive-sim") {
    throw new Error("unknown backend");
  }
  return new LocalFolderStore(path.resolve(storesRoot, backend));
}

// M14 #97: finds the backend holding a signed identity. M15 #100: only the
// /i/<fp> link searches both porches; the invite panel reads the operator's.
const INVITE_BACKENDS = ["nextcloud-sim", "google-drive-sim"] as const;

async function findInviteIdentity(
  fingerprint?: string,
): Promise<{ identity: NonNullable<Awaited<ReturnType<typeof porchIdentity>>>; backend: string } | null> {
  for (const backend of INVITE_BACKENDS) {
    const identity = await porchIdentity(simStore(backend));
    if (identity && (fingerprint === undefined || identity.fingerprint === fingerprint)) {
      return { identity, backend };
    }
  }
  return null;
}

class BodyTooLargeError extends Error {
  constructor() { super("body too large"); this.name = "BodyTooLargeError"; }
}

async function readJsonBody(req: http.IncomingMessage, limit = 32 * 1024): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new BodyTooLargeError();
    chunks.push(chunk as Buffer);
  }
  if (chunks.length === 0) return {};
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function send(res: http.ServerResponse, status: number, body: unknown, contentType = "application/json"): void {
  const text = contentType === "application/json" ? JSON.stringify(body) : String(body);
  res.writeHead(status, { "content-type": contentType });
  res.end(text);
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

// In-memory sessions: { token -> createdAt }. Single-operator demo;
// sessions expire after 30 days of server uptime (restart clears all).
const sessions = new Map<string, number>();
const SESSION_TTL_MS = 30 * 24 * 3600 * 1000;

function sweepSessions(now = Date.now()): void {
  for (const [token, created] of sessions) {
    if (now - created > SESSION_TTL_MS) sessions.delete(token);
  }
}

// Cookies: HttpOnly + SameSite=Lax always; Secure when COOKIE_SECURE=1
// or when the request arrived over TLS (direct or via X-Forwarded-Proto).
// Auto-detection keeps public HTTPS deploys safe when the operator
// forgets the flag; plain-HTTP tailnet/local stays login-capable.
const cookieSecureForced = process.env.COOKIE_SECURE === "1";
function isTlsRequest(req: http.IncomingMessage): boolean {
  const proto = (req.headers["x-forwarded-proto"] as string | undefined)?.split(",")[0]?.trim().toLowerCase();
  if (proto === "https") return true;
  return (req.socket as { encrypted?: boolean }).encrypted === true;
}
function sessionCookie(value: string | null, req?: http.IncomingMessage): string {
  const base = value === null ? "ownplace_session=; HttpOnly; Path=/; SameSite=Lax; Max-Age=0" : "ownplace_session=" + value + "; HttpOnly; Path=/; SameSite=Lax";
  const secure = cookieSecureForced || (req !== undefined && isTlsRequest(req));
  return secure ? base + "; Secure" : base;
}

function newSession(): string {
  // CSPRNG session IDs: Math.random is predictable and must never mint secrets.
  sweepSessions();
  const token = randomBytes(32).toString("hex");
  sessions.set(token, Date.now());
  return token;
}

function readSessionCookie(req: http.IncomingMessage): string | null {
  const header = req.headers.cookie ?? "";
  for (const part of header.split(";")) {
    const [k, ...rest] = part.trim().split("=");
    if (k === "ownplace_session") return rest.join("=").trim() || null;
  }
  return null;
}

function destroySession(session: string): void {
  sessions.delete(session);
}

function isAuthenticated(req: http.IncomingMessage): boolean {
  if (!writeToken) return true; // dev mode (warned at startup)
  sweepSessions();
  const header = req.headers.authorization ?? "";
  if (header.startsWith("Bearer ") && timingSafeEqual(header.slice(7), writeToken)) return true;
  const session = readSessionCookie(req);
  if (!session) return false;
  const created = sessions.get(session);
  if (created === undefined) return false;
  if (Date.now() - created > SESSION_TTL_MS) {
    sessions.delete(session);
    return false;
  }
  return true;
}

function authorized(req: http.IncomingMessage): boolean {
  return isAuthenticated(req);
}

const MIME: Record<string, string> = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".css": "text/css",
  ".json": "application/json",
};

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url ?? "/", "http://localhost");
    const { pathname } = url;

    // --- Reads (public, history authenticated) ---
    // Timeline entries derive solely from Ed25519-verified history packages.
    // Unsigned timeline.json values are never presented as authenticated;
    // tampered, unsigned, or legacy-placeholder entries are excluded.
    if (req.method === "GET" && pathname === "/api/timeline") {
      const backend = url.searchParams.get("backend") ?? "nextcloud-sim";
      if (backend !== "nextcloud-sim" && backend !== "google-drive-sim") {
        send(res, 400, { error: "unknown backend" });
        return;
      }
      try {
        // M15 #100: each porch reads its own address book, so a column shows
        // its owner's posts plus the Kinfolk that owner follows. Followed
        // porches are verified independently. M15 #101: comments and wall
        // posts are attached to their targets; `owner` is the porch owner's
        // key fingerprint (from verified posts) when there is exactly one.
        const now = new Date().toISOString();
        const merged = await readThreadedTimeline(storesRoot, backend, now, backend);
        send(res, 200, {
          protocol: "rooted/v0.1",
          kind: "timeline",
          updatedAt: now,
          ...(merged.owner ? { owner: merged.owner } : {}),
          stories: merged.stories,
          skipped: merged.skipped,
        });
      } catch {
        send(res, 404, { error: "no timeline" });
      }
      return;
    }
    if (req.method === "GET" && pathname === "/api/story") {
      const backend = url.searchParams.get("backend") ?? "nextcloud-sim";
      if (backend !== "nextcloud-sim" && backend !== "google-drive-sim") {
        send(res, 400, { error: "unknown backend" });
        return;
      }
      const id = url.searchParams.get("id") ?? "";
      if (!id || !isSafeHistoryId(id) || id.includes("\0")) {
        send(res, 400, { error: "bad id" });
        return;
      }
      try {
        // Verified history package only: rejects tampered, missing-signature,
        // and legacy demo-placeholder packages with 404 (never serve them).
        const story = await readVerifiedFollowedStory(storesRoot, backend, id, backend);
        send(res, 200, story);
      } catch {
        send(res, 404, { error: "not found" });
      }
      return;
    }
    // --- Sealed media reader (M8 #66) ---
    // Opens a gated story's sealed body+media for a reader who presents
    // their private key. Trust note (demo-grade, docs state this): the key
    // transits server memory for this request only — never logged, never
    // stored. No key: use /api/story (index metadata only, stranger-safe).
    // Failures share one fixed message (no key-oracle, no reason split).
    if (req.method === "POST" && pathname === "/api/open") {
      let input: unknown;
      try {
        input = await readJsonBody(req);
      } catch (e) {
        if (e instanceof BodyTooLargeError) send(res, 413, { error: "body too large" });
        else send(res, 400, { error: "invalid JSON body" });
        return;
      }
      const rec = (input ?? {}) as Record<string, unknown>;
      const backend = typeof rec.backend === "string" ? rec.backend : "nextcloud-sim";
      if (backend !== "nextcloud-sim" && backend !== "google-drive-sim") {
        send(res, 400, { error: "unknown backend" });
        return;
      }
      const id = typeof rec.id === "string" ? rec.id : "";
      if (!id || !isSafeHistoryId(id) || id.includes("\0")) {
        send(res, 400, { error: "bad id" });
        return;
      }
      // Public stories open keyless (reads are public by design): load and
      // branch before demanding a key, so unrestricted packages keep their
      // old shape. Falsy check covers cross-version missing/null markers.
      let story;
      try {
        story = await readVerifiedFollowedStory(storesRoot, backend, id, backend);
      } catch {
        send(res, 404, { error: "not found" });
        return;
      }
      if (!story.restricted) {
        send(res, 200, { status: "public", body: story.body, media: [] });
        return;
      }
      const readerKey = typeof rec.readerKey === "string" ? rec.readerKey : "";
      if (!readerKey || readerKey.length > 8192) {
        send(res, 400, { error: "bad reader key" });
        return;
      }
      const rawReaderId = rec.readerId;
      const readerId = rawReaderId === undefined ? undefined : typeof rawReaderId === "string" ? rawReaderId : null;
      if (readerId === null || (readerId !== undefined && !isSafeReaderId(readerId))) {
        send(res, 400, { error: "bad reader id" });
        return;
      }
      const opened = tryOpenStory(story, readerKey, readerId);
      if (opened.status !== "opened") {
        send(res, 403, { error: "cannot open" });
        return;
      }
      send(res, 200, { status: "opened", body: opened.body, media: opened.media });
      return;
    }
    if (req.method === "GET" && pathname === "/api/contacts") {
      const backend = url.searchParams.get("backend") ?? operatorPorch;
      if (backend !== "nextcloud-sim" && backend !== "google-drive-sim") {
        send(res, 400, { error: "unknown backend" });
        return;
      }
      const list = await readContacts(simStore(backend));
      send(res, 200, list);
      return;
    }
    if (req.method === "GET" && pathname === "/api/health") {
      send(res, 200, { ok: true });
      return;
    }
    if (req.method === "GET" && pathname === "/api/session") {
      send(res, 200, { authenticated: isAuthenticated(req) });
      return;
    }
    if (req.method === "POST" && pathname === "/api/login") {
      let input: unknown;
      try {
        input = await readJsonBody(req);
      } catch {
        send(res, 400, { error: "invalid JSON body" });
        return;
      }
      const token = ((input ?? {}) as Record<string, unknown>).token;
      if (typeof token !== "string" || !timingSafeEqual(token, writeToken) || !writeToken) {
        send(res, 401, { error: "unauthorized" });
        return;
      }
      const session = newSession();
      res.writeHead(200, {
        "content-type": "application/json",
        "set-cookie": sessionCookie(session, req),
      });
      res.end(JSON.stringify({ ok: true }));
      return;
    }
    if (req.method === "POST" && pathname === "/api/logout") {
      const session = readSessionCookie(req);
      if (session) destroySession(session);
      res.writeHead(200, {
        "content-type": "application/json",
        "set-cookie": sessionCookie(null, req),
      });
      res.end(JSON.stringify({ ok: true }));
      return;
    }

    // --- Writes (token-gated) ---
    if (req.method === "POST" && pathname === "/api/post") {
      if (!authorized(req)) {
        send(res, 401, { error: "unauthorized" });
        return;
      }
      let input: unknown;
      try {
        input = await readJsonBody(req);
      } catch (e) {
        if (e instanceof BodyTooLargeError) {
          send(res, 413, { error: "body too large" });
        } else {
          send(res, 400, { error: "invalid JSON body" });
        }
        return;
      }
      const rec = (input ?? {}) as Record<string, unknown>;
      // M15 #100: the composer posts as the logged-in Kinfolk only.
      if ((rec.authorId !== undefined && rec.authorId !== operator.id) || rec.authorName !== undefined) {
        send(res, 400, { error: "can only post as the logged-in Kinfolk" });
        return;
      }
      let validated;
      try {
        validated = validateInput({
          title: rec.title as string,
          body: rec.body as string,
          authorId: operator.id,
          authorName: operator.displayName,
          to: rec.to,
          inReplyTo: rec.inReplyTo,
        });
        // M15 #101: a comment names a post the operator can see; a wall
        // post names someone the operator follows. Fixed messages only.
        await checkReplyTarget(storesRoot, operatorPorch, validated);
      } catch (e) {
        send(res, 400, { error: (e as Error).message });
        return;
      }
      const result = await publishStory(validated, backendsFromEnv(repoRoot));
      send(res, 201, result);
      return;
    }
    if (req.method === "DELETE" && pathname === "/api/post") {
      if (!authorized(req)) {
        send(res, 401, { error: "unauthorized" });
        return;
      }
      // M15 #101: the operator deletes their own comment or wall post from
      // their own porch; readers stop showing it on their next read.
      const id = url.searchParams.get("id") ?? "";
      try {
        send(res, 200, await deleteReply(operator.id, id, backendsFromEnv(repoRoot)));
      } catch (e) {
        const message = (e as Error).message;
        if (message === DELETE_REFUSED.notReply) send(res, 400, { error: message });
        else if (message === DELETE_REFUSED.missing) send(res, 404, { error: message });
        else throw e;
      }
      return;
    }
    if (req.method === "POST" && pathname === "/api/hidden") {
      if (!authorized(req)) {
        send(res, 401, { error: "unauthorized" });
        return;
      }
      let input: unknown;
      try {
        input = await readJsonBody(req);
      } catch {
        send(res, 400, { error: "invalid JSON body" });
        return;
      }
      if (!isReplyTarget(input)) {
        send(res, 400, { error: "bad reply" });
        return;
      }
      // M15 #101: the operator hides, on their own porch only, someone
      // else's reply aimed at them. Nothing is changed on the author's porch.
      const view = await readThreadedTimeline(storesRoot, operatorPorch, new Date().toISOString(), operatorPorch);
      const target = hideableReply(view, input);
      if (!target) {
        send(res, 404, { error: "not found" });
        return;
      }
      await hideReply(simStore(operatorPorch), target);
      send(res, 201, target);
      return;
    }
    if (req.method === "POST" && pathname === "/api/contacts/invite") {
      if (!authorized(req)) {
        send(res, 401, { error: "unauthorized" });
        return;
      }
      let input: unknown;
      try {
        input = await readJsonBody(req);
      } catch {
        send(res, 400, { error: "invalid JSON body" });
        return;
      }
      const invite = ((input ?? {}) as Record<string, unknown>).invite;
      if (typeof invite !== "string" || invite.length > 400) {
        send(res, 400, { error: "invite link is required" });
        return;
      }
      try {
        // resolveInvite only throws fixed, public-safe messages.
        const contact = await resolveInvite(invite);
        await addContact(simStore(operatorPorch), contact);
        send(res, 201, contact);
      } catch (e) {
        send(res, 400, { error: (e as Error).message });
      }
      return;
    }
    if ((req.method === "POST" || req.method === "DELETE") && pathname === "/api/contacts") {
      if (!authorized(req)) {
        send(res, 401, { error: "unauthorized" });
        return;
      }
      const store = simStore(operatorPorch);
      if (req.method === "DELETE") {
        const id = (url.searchParams.get("id") ?? "").trim();
        if (!id || id.includes("/") || id.includes("\\") || id.includes("..") || id.includes("\0")) {
          send(res, 400, { error: "bad id" });
          return;
        }
        const before = (await readContacts(store)).contacts.length;
        const list = await removeContact(store, id);
        if (list.contacts.length === before) {
          send(res, 404, { error: "contact not found" });
          return;
        }
        send(res, 200, list);
        return;
      }
      let input: unknown;
      try {
        input = await readJsonBody(req);
      } catch (e) {
        if (e instanceof BodyTooLargeError) {
          send(res, 413, { error: "body too large" });
        } else {
          send(res, 400, { error: "invalid JSON body" });
        }
        return;
      }
      try {
        const contact = validateContact((input ?? {}) as { id?: unknown; displayName?: unknown; address?: unknown });
        send(res, 201, await addContact(store, contact));
      } catch (e) {
        send(res, 400, { error: (e as Error).message });
        return;
      }
      return;
    }

    // --- Invitations (M12 #92) ---
    // Public-safe: fingerprint, display name, bio, and a relative porch
    // path. No storage paths, tokens, or contacts.
    if (req.method === "GET" && pathname === "/api/invite") {
      // M15 #100: no backend => the operator's own porch only. The two
      // porches are two people, so the panel never falls back to the other.
      const backend = url.searchParams.get("backend");
      if (backend !== null && backend !== "nextcloud-sim" && backend !== "google-drive-sim") {
        send(res, 400, { error: "unknown backend" });
        return;
      }
      const identity = await porchIdentity(simStore(backend ?? operatorPorch));
      if (!identity) {
        send(res, 404, { error: "no signed identity on this porch yet" });
        return;
      }
      send(res, 200, { ...identity, path: `i/${identity.fingerprint}` });
      return;
    }
    if (req.method === "GET" && pathname.startsWith("/i/")) {
      const json = pathname.endsWith(".json");
      const m = INVITE_PATH.exec(json ? pathname.slice(0, -5) : pathname.replace(/\/$/, ""));
      if (!m) {
        send(res, 404, { error: "not found" });
        return;
      }
      if (!json) {
        // Landing page: the SPA renders it from the invite document.
        try {
          const data = await readFile(path.resolve(distDir, "index.html"));
          res.writeHead(200, { "content-type": "text/html" });
          res.end(data);
        } catch {
          send(res, 404, "not found", "text/plain");
        }
        return;
      }
      const found = await findInviteIdentity(m[1]);
      if (found) {
        send(res, 200, buildInviteDocument(found.identity, found.backend));
        return;
      }
      send(res, 404, { error: "not found" });
      return;
    }

    // --- Public porch (M11 #90) ---
    // Read-only package files so other OwnPlace instances can follow this
    // porch over https. Allowlist only: timeline.json (an untrusted id hint
    // for followers) and signed package files. contacts.json and anything
    // else stay private. Sealed bodies stay sealed.
    if (req.method === "GET" && pathname.startsWith("/porch/")) {
      const m = /^\/porch\/([^/]+)\/(timeline\.json|timeline\/([^/]+)\/([^/]+))$/.exec(pathname);
      const backend = m?.[1] ?? "";
      const id = m?.[3];
      const file = m?.[4];
      const allowed =
        m !== null &&
        (backend === "nextcloud-sim" || backend === "google-drive-sim") &&
        (id === undefined || (isSafeHistoryId(id) && (PORCH_PACKAGE_FILES as readonly string[]).includes(file ?? "")));
      if (!allowed) {
        send(res, 404, { error: "not found" });
        return;
      }
      try {
        const data = await simStore(backend).readObject(m![2]);
        res.writeHead(200, { "content-type": "application/json", "cache-control": "public, max-age=30" });
        res.end(data);
      } catch {
        send(res, 404, { error: "not found" });
      }
      return;
    }

    // --- Static bundle ---
    if (req.method === "GET") {
      const rel = pathname === "/" ? "index.html" : pathname.replace(/^\//, "").split("?")[0];
      const resolved = path.resolve(distDir, rel);
      if (resolved !== distDir && !resolved.startsWith(distDir + path.sep)) {
        send(res, 400, { error: "bad path" });
        return;
      }
      try {
        const data = await readFile(resolved);
        const ext = path.extname(rel);
        res.writeHead(200, { "content-type": MIME[ext] ?? "application/octet-stream" });
        res.end(data);
      } catch {
        send(res, 404, "not found", "text/plain");
      }
      return;
    }
    send(res, 405, { error: "method not allowed" });
  } catch (e) {
    console.error("request failed:", (e as Error).message);
    send(res, 500, { error: "internal error" });
  }
});

server.listen(port, "127.0.0.1", () => {
  // Log the bound port (not the requested one) so PORT=0 ephemeral
  // binds are discoverable by test harnesses.
  const bound = server.address();
  const shown = typeof bound === "object" && bound !== null ? bound.port : port;
  console.log(`OwnPlace API + web on http://127.0.0.1:${shown}`);
});
