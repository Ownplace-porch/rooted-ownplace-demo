import { StrictMode, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import "./style.css";
import { authorName, originLabel, wallLabel } from "./origin";
import QRCode from "qrcode";

// M15 #101: signer and reply fields come from verified packages (server).
type TimelineEntry = {
  id: string; title: string; authorId: string; createdAt: string; verified?: boolean; origin?: string;
  signer?: string; to?: { fingerprint: string }; inReplyTo?: { fingerprint: string; storyId: string };
  sealed?: true; comments?: TimelineEntry[];
  // M16 #116: decrypted by the server for a logged-in reader.
  encrypted?: true;
};
type Timeline = { owner?: string; stories: TimelineEntry[] };
type Story = { id: string; title: string; body: string; createdAt: string; authorId: string; restricted?: unknown };
type Contact = { id: string; displayName: string; addedAt: string; address?: string; fingerprint?: string };
type InviteInfo = { fingerprint: string; displayName: string; bio?: string; path: string };
type InviteDoc = { kind: "invite"; fingerprint: string; displayName: string; bio?: string };
type ContactList = { contacts: Contact[] };

// M15 #100: two Kinfolk, one cloud each. The operator (logged in) is Alex.
const PORCHES = [
  { backend: "nextcloud-sim", kinfolk: "Alex", cloud: "Nextcloud" },
  { backend: "google-drive-sim", kinfolk: "Sam", cloud: "Google Drive" },
];
const OPERATOR = PORCHES[0];

function isEntry(s: unknown): s is TimelineEntry {
  if (typeof s !== "object" || s === null) return false;
  const e = s as Record<string, unknown>;
  return (
    typeof e.id === "string" && e.id.length > 0 &&
    typeof e.title === "string" &&
    typeof e.authorId === "string" && e.authorId.length > 0 &&
    typeof e.createdAt === "string" && !Number.isNaN(Date.parse(e.createdAt))
  );
}

function sortEntries(list: TimelineEntry[]): TimelineEntry[] {
  return [...list].sort(
    (a, b) => b.createdAt.localeCompare(a.createdAt) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
  );
}

function formatDate(iso: string): string {
  const t = Date.parse(iso);
  return Number.isNaN(t) ? "unknown date" : new Date(t).toLocaleString();
}

async function safeJson(res: Response): Promise<unknown | null> {
  try {
    return await res.json();
  } catch {
    return null;
  }
}

async function loadTimeline(backend: string): Promise<{ owner?: string; entries: TimelineEntry[] }> {
  // Server authenticates: entries derive from Ed25519-verified history
  // packages only. Unsigned or tampered entries are excluded server-side
  // and never rendered here.
  let res: Response;
  try {
    res = await fetch(`/api/timeline?backend=${encodeURIComponent(backend)}`);
  } catch {
    throw new Error("unreachable");
  }
  if (res.status === 404) return { entries: [] };
  if (!res.ok) throw new Error(`backend error ${res.status}`);
  const parsed = await safeJson(res);
  if (!parsed || typeof parsed !== "object" || !Array.isArray((parsed as Timeline).stories)) {
    throw new Error("malformed timeline");
  }
  const owner = typeof (parsed as Timeline).owner === "string" ? (parsed as Timeline).owner : undefined;
  const entries = sortEntries((parsed as Timeline).stories.filter(isEntry)).map((e) => ({
    ...e,
    comments: Array.isArray(e.comments) ? e.comments.filter(isEntry) : [],
  }));
  return { owner, entries };
}

async function loadStory(backend: string, id: string): Promise<Story | null> {
  let res: Response;
  try {
    res = await fetch(`/api/story?backend=${encodeURIComponent(backend)}&id=${encodeURIComponent(id)}`);
  } catch {
    return null;
  }
  if (!res.ok) return null;
  const parsed = await safeJson(res);
  if (!parsed || typeof (parsed as Story).title !== "string") return null;
  return parsed as Story;
}

function useBackend(backend: string, refresh: number) {
  const [state, setState] = useState<
    | { status: "loading" }
    | { status: "error"; message: string }
    | { status: "empty" }
    | { status: "ready"; owner?: string; entries: TimelineEntry[]; stories: Record<string, Story> }
  >({ status: "loading" });
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const { owner, entries: list } = await loadTimeline(backend);
        if (list.length === 0) {
          if (!cancelled) setState({ status: "empty" });
          return;
        }
        // Comments are verified stories too; load them like posts.
        const ids = list.flatMap((e) => [e.id, ...(e.comments ?? []).map((c) => c.id)]);
        const pairs = await Promise.all(
          ids.map(async (id) => [id, await loadStory(backend, id)] as const)
        );
        if (!cancelled) {
          setState({
            status: "ready",
            owner,
            entries: list,
            stories: Object.fromEntries(pairs.filter(([, s]) => s !== null) as [string, Story][]),
          });
        }
      } catch (e) {
        if (!cancelled) setState({ status: "error", message: (e as Error).message });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [backend, refresh]);
  return state;
}

function Composer({ onPosted }: { onPosted: () => void }) {
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  // M16 #116: posts are encrypted to Alex's Kinfolk unless this is ticked.
  const [isPublic, setIsPublic] = useState(false);
  const [status, setStatus] = useState<string>("");
  const [busy, setBusy] = useState(false);
  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setStatus("");
    try {
      const res = await fetch("/api/post", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title, body, public: isPublic }),
      });
      const parsed = (await safeJson(res)) as { storyId?: string; error?: string } | null;
      if (!res.ok) {
        setStatus(`Post failed: ${parsed?.error ?? res.status}`);
      } else {
        setStatus(`Posted ${parsed?.storyId ?? ""} to ${OPERATOR.kinfolk}'s porch on ${OPERATOR.cloud}.`);
        setTitle("");
        setBody("");
        setIsPublic(false);
        onPosted();
      }
    } catch (err) {
      setStatus(`Post failed: ${(err as Error).message}`);
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="composer">
      <h2>New post</h2>
      <p className="lede">Posting as {OPERATOR.kinfolk} · {OPERATOR.cloud}. Posts are encrypted: only {OPERATOR.kinfolk} and Kinfolk who follow each other with {OPERATOR.kinfolk} can read them.</p>
      <form onSubmit={submit}>
        <input
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="Title (max 140)"
          maxLength={140}
          aria-label="Title"
        />
        <textarea
          value={body}
          onChange={(e) => setBody(e.target.value)}
          placeholder="What is happening?"
          maxLength={5000}
          rows={4}
          aria-label="Body"
        />
        <label className="toggle">
          <input type="checkbox" checked={isPublic} onChange={(e) => setIsPublic(e.target.checked)} /> Public post (anyone with the porch link can read it)
        </label>
        <button type="submit" disabled={busy || !title.trim() || !body.trim()}>
          {busy ? "Posting…" : "Post to timeline"}
        </button>
      </form>
      {status && <p className="date">{status}</p>}
    </section>
  );
}

function Contacts({ onChanged }: { onChanged?: () => void }) {
  const [list, setList] = useState<Contact[]>([]);
  const [id, setId] = useState("");
  const [name, setName] = useState("");
  const [address, setAddress] = useState("");
  const [status, setStatus] = useState("");
  async function refresh() {
    try {
      const res = await fetch("/api/contacts");
      const parsed = (await safeJson(res)) as ContactList | null;
      setList(Array.isArray(parsed?.contacts) ? parsed.contacts : []);
    } catch {
      setList([]);
    }
  }
  useEffect(() => {
    refresh();
  }, []);
  async function add(e: React.FormEvent) {
    e.preventDefault();
    setStatus("");
    const res = await fetch("/api/contacts", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id, displayName: name, address }),
    });
    const parsed = (await safeJson(res)) as { error?: string } | null;
    if (!res.ok) {
      setStatus(`Couldn't add: ${parsed?.error ?? res.status}`);
    } else {
      setId("");
      setName("");
      setAddress("");
      refresh();
      onChanged?.();
    }
  }
  async function remove(contactId: string) {
    if (!window.confirm(`Unfollow ${contactId}?`)) return;
    setStatus("");
    const res = await fetch(`/api/contacts?id=${encodeURIComponent(contactId)}`, { method: "DELETE" });
    if (!res.ok) {
      const parsed = (await safeJson(res)) as { error?: string } | null;
      setStatus(`Couldn't remove: ${parsed?.error ?? res.status}`);
      return;
    }
    refresh();
    onChanged?.();
  }
  return (
    <section className="composer">
      <h2>Syndication contacts</h2>
      <p className="lede">Kinfolk you follow. Timeline entries are labeled with the porch they came from.</p>
      <ul>
        {list.map((c) => (
          <li key={c.id}>
            {c.displayName} <code>{c.id}</code>{" "}
            {c.address && <code>{c.address}</code>}{" "}
            {c.fingerprint && <span className="date">verified key {shortFingerprint(c.fingerprint)}… </span>}
            <button onClick={() => remove(c.id)}>Unfollow</button>
          </li>
        ))}
        {list.length === 0 && <li>No contacts yet.</li>}
      </ul>
      <form onSubmit={add}>
        <input value={id} onChange={(e) => setId(e.target.value)} placeholder="kinfolk id" aria-label="Contact id" />
        <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Display name" aria-label="Display name" />
        <input value={address} onChange={(e) => setAddress(e.target.value)} placeholder="local:google-drive-sim or https://porch" aria-label="Porch address" />
        <button type="submit" disabled={!id.trim() || !name.trim() || !address.trim()}>Follow</button>
      </form>
      {status && <p className="date">{status}</p>}
    </section>
  );
}


// --- Invitations (M12 #92) ---

function shortFingerprint(fp: string): string {
  return fp.slice(0, 16).replace(/(.{4})(?=.)/g, "$1 ");
}

function useQr(text: string): string {
  const [src, setSrc] = useState("");
  useEffect(() => {
    let live = true;
    if (!text) return;
    QRCode.toDataURL(text, { margin: 1, width: 220 }).then((url) => live && setSrc(url), () => live && setSrc(""));
    return () => {
      live = false;
    };
  }, [text]);
  return src;
}

function YourInvite() {
  const [info, setInfo] = useState<InviteInfo | null | undefined>(undefined);
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    // M14 #97: server picks the backend, same order as the /i/ link.
    fetch("/api/invite")
      .then(async (res) => (res.ok ? ((await safeJson(res)) as InviteInfo | null) : null))
      .then((v) => setInfo(v && typeof v.fingerprint === "string" ? v : null), () => setInfo(null));
  }, []);
  const link = info ? new URL(info.path, window.location.origin + "/").href : "";
  const qr = useQr(link);
  if (info === undefined) return null;
  return (
    <section className="composer">
      <h2>Your invite</h2>
      {info === null ? (
        <p className="lede">Publish a post first. The invite is tied to the key that signs your posts.</p>
      ) : (
        <>
          <p className="lede">
            Share this link or QR code anywhere. It names you by key fingerprint{" "}
            <code>{shortFingerprint(info.fingerprint)}…</code> and reveals no storage location.
          </p>
          <p>
            <code>{link}</code>{" "}
            <button
              onClick={() => navigator.clipboard?.writeText(link).then(() => setCopied(true), () => setCopied(false))}
            >
              {copied ? "Copied" : "Copy link"}
            </button>
          </p>
          {qr && <img src={qr} width={220} height={220} alt={`QR code for ${link}`} />}
        </>
      )}
    </section>
  );
}

function FollowByInvite({ onChanged }: { onChanged?: () => void }) {
  const [invite, setInvite] = useState("");
  const [status, setStatus] = useState("");
  const [busy, setBusy] = useState(false);
  async function follow(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setStatus("Checking the invite and verifying the creator's signature…");
    try {
      const res = await fetch("/api/contacts/invite", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ invite }),
      });
      const parsed = (await safeJson(res)) as (Contact & { error?: string }) | null;
      if (!res.ok || !parsed) {
        setStatus(`Couldn't follow: ${parsed?.error ?? res.status}`);
        return;
      }
      setInvite("");
      setStatus(`Following ${parsed.displayName} (verified key ${shortFingerprint(parsed.fingerprint ?? "")}…).`);
      onChanged?.();
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="composer">
      <h2>Follow by invite</h2>
      <p className="lede">Paste an OwnPlace invite link. The follow only succeeds if the porch has a post signed by that creator's key.</p>
      <form onSubmit={follow}>
        <input value={invite} onChange={(e) => setInvite(e.target.value)} placeholder="https://…/i/…" aria-label="Invite link" />
        <button type="submit" disabled={busy || !invite.trim()}>Follow</button>
      </form>
      {status && <p className="date">{status}</p>}
    </section>
  );
}

function InviteLanding() {
  const [doc, setDoc] = useState<InviteDoc | null | undefined>(undefined);
  const [copied, setCopied] = useState(false);
  const link = window.location.href.split(/[?#]/)[0].replace(/\/$/, "");
  useEffect(() => {
    fetch(`${link}.json`)
      .then(async (res) => (res.ok ? ((await safeJson(res)) as InviteDoc | null) : null))
      .then((v) => setDoc(v?.kind === "invite" ? v : null), () => setDoc(null));
  }, [link]);
  const qr = useQr(doc ? link : "");
  return (
    <main>
      <header>
        <p className="eyebrow">ROOTED / OWNPLACE · INVITATION</p>
        {doc === undefined && <h1>Loading invite…</h1>}
        {doc === null && <h1>This invite isn't available.</h1>}
        {doc && (
          <>
            <h1>{doc.displayName} invited you to their porch.</h1>
            {doc.bio && <p className="lede">{doc.bio}</p>}
          </>
        )}
      </header>
      {doc && (
        <section className="composer">
          <h2>How to follow</h2>
          <ol>
            <li>Open your own OwnPlace and log in.</li>
            <li>Paste this link into <strong>Follow by invite</strong>.</li>
            <li>Your OwnPlace checks that the posts are really signed by {doc.displayName}'s key before following.</li>
          </ol>
          <p>
            <code>{link}</code>{" "}
            <button onClick={() => navigator.clipboard?.writeText(link).then(() => setCopied(true), () => setCopied(false))}>
              {copied ? "Copied" : "Copy link"}
            </button>
          </p>
          {qr && <img src={qr} width={220} height={220} alt={`QR code for ${link}`} />}
          <p className="date">Creator key fingerprint: <code>{doc.fingerprint}</code></p>
          <p className="date">No wallet, token, or storage account is needed to follow.</p>
        </section>
      )}
    </main>
  );
}

function isHttpsUrl(u: unknown): u is string {
  return typeof u === "string" && u.startsWith("https://");
}

function MediaView({ media }: { media: string[] }) {
  // Belt and braces: server only returns contract-checked media, but the
  // renderer independently refuses non-https pointers before fetching.
  const safe = media.filter(isHttpsUrl);
  if (safe.length === 0) return null;
  return (
    <div className="media">
      {safe.map((u) => {
        const lower = u.split("?")[0].toLowerCase();
        const isImage = /\.(jpg|jpeg|png|gif|webp|avif)$/.test(lower);
        const isVideo = /\.(mp4|webm|mov)$/.test(lower);
        return (
          <div key={u} className="media-item">
            {isImage ? (
              <img src={u} loading="lazy" alt="Sealed story media" />
            ) : isVideo ? (
              <video src={u} controls preload="metadata" />
            ) : (
              <a href={u} target="_blank" rel="noreferrer">{u}</a>
            )}
          </div>
        );
      })}
    </div>
  );
}

function Unlocker({ backend, id }: { backend: string; id: string }) {
  const [key, setKey] = useState("");
  const [readerId, setReaderId] = useState("");
  const [busy, setBusy] = useState(false);
  const [state, setState] = useState<
    | null
    | { ok: true; body: string; media: string[] }
    | { ok: false }
  >(null);
  async function open(e: React.FormEvent) {
    e.preventDefault();
    if (busy || !key.trim()) return;
    setBusy(true);
    setState(null);
    try {
      const res = await fetch("/api/open", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ backend, id, readerKey: key, readerId: readerId.trim() || undefined }),
      });
      const parsed = (await safeJson(res)) as { status?: unknown; body?: unknown; media?: unknown } | null;
      if (res.ok && parsed?.status === "opened" && typeof parsed.body === "string" && Array.isArray(parsed.media)) {
        setState({ ok: true, body: parsed.body, media: (parsed.media as unknown[]).filter(isHttpsUrl) });
      } else {
        setState({ ok: false });
      }
    } catch {
      setState({ ok: false });
    } finally {
      setBusy(false);
    }
  }
  if (state?.ok) {
    return (
      <div>
        <p>{state.body}</p>
        <MediaView media={state.media} />
      </div>
    );
  }
  return (
    <div>
      <p>Restricted to entitled Kinfolk: title and metadata are public, the body is sealed.</p>
      <form onSubmit={open}>
        <input
          value={readerId}
          onChange={(e) => setReaderId(e.target.value)}
          placeholder="reader id (optional)"
          aria-label="Reader id"
        />
        <textarea
          value={key}
          onChange={(e) => setKey(e.target.value)}
          placeholder="Paste reader private key to unlock"
          aria-label="Reader private key"
        />
        <button type="submit" disabled={busy || !key.trim()}>Unlock</button>
      </form>
      {state && !state.ok && <p className="date">Cannot open with this key.</p>}
    </div>
  );
}

// --- Comments and wall posts (M15 #101) ---
// Both publish to the logged-in Kinfolk's own porch; the server checks the
// target before signing.

function ReplyBox({ label, placeholder, target, onDone }: {
  label: string;
  placeholder: string;
  target: { inReplyTo: { fingerprint: string; storyId: string } } | { to: { fingerprint: string } };
  onDone: () => void;
}) {
  const [body, setBody] = useState("");
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState("");
  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (busy || !body.trim()) return;
    setBusy(true);
    setStatus("");
    try {
      const res = await fetch("/api/post", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ body, ...target }),
      });
      const parsed = (await safeJson(res)) as { error?: string } | null;
      if (!res.ok) {
        setStatus(`Couldn't post: ${parsed?.error ?? res.status}`);
        return;
      }
      setBody("");
      onDone();
    } catch (err) {
      setStatus(`Couldn't post: ${(err as Error).message}`);
    } finally {
      setBusy(false);
    }
  }
  return (
    <form className="reply-box" onSubmit={submit}>
      <textarea value={body} onChange={(e) => setBody(e.target.value)} placeholder={placeholder} maxLength={5000} rows={2} aria-label={label} />
      <button type="submit" disabled={busy || !body.trim()}>{busy ? "Posting…" : label}</button>
      {status && <p className="date">{status}</p>}
    </form>
  );
}

function ReplyActions({ entry, canDelete, canHide, onDone }: { entry: TimelineEntry; canDelete: boolean; canHide: boolean; onDone: () => void }) {
  const [status, setStatus] = useState("");
  async function act(kind: "delete" | "hide") {
    const ask = kind === "delete" ? "Delete this from your porch for everyone?" : "Hide this on your porch? The author's copy is not changed.";
    if (!window.confirm(ask)) return;
    setStatus("");
    const res = kind === "delete"
      ? await fetch(`/api/post?id=${encodeURIComponent(entry.id)}`, { method: "DELETE" })
      : await fetch("/api/hidden", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ fingerprint: entry.signer, storyId: entry.id }),
      });
    if (!res.ok) {
      const parsed = (await safeJson(res)) as { error?: string } | null;
      setStatus(`Couldn't ${kind}: ${parsed?.error ?? res.status}`);
      return;
    }
    onDone();
  }
  if (!canDelete && !canHide) return null;
  return (
    <span className="reply-actions">
      {canDelete && <button onClick={() => act("delete")}>Delete</button>}
      {canHide && <button onClick={() => act("hide")}>Hide</button>}
      {status && <span className="date">{status}</span>}
    </span>
  );
}

function BackendColumn({ backend, kinfolk, cloud, refresh, authed, operatorFp, onChanged }: {
  backend: string; kinfolk: string; cloud: string; refresh: number;
  authed: boolean; operatorFp?: string; onChanged: () => void;
}) {
  const state = useBackend(backend, refresh);
  // M15 #101: the operator writes and deletes as themselves; hiding happens
  // only in the operator's own column, on replies aimed at them.
  const mine = (e: TimelineEntry) => authed && operatorFp !== undefined && e.signer === operatorFp;
  const hideable = (e: TimelineEntry, targetsOwner: boolean) =>
    authed && backend === OPERATOR.backend && targetsOwner && operatorFp !== undefined && e.signer !== operatorFp;
  const [contacts, setContacts] = useState<Contact[]>([]);
  useEffect(() => {
    // M15 #100: origin labels come from this porch's own contacts.
    fetch(`/api/contacts?backend=${encodeURIComponent(backend)}`)
      .then(async (res) => {
        const parsed = (await safeJson(res)) as ContactList | null;
        setContacts(Array.isArray(parsed?.contacts) ? parsed.contacts : []);
      })
      .catch(() => setContacts([]));
  }, [backend, refresh]);
  return (
    <article>
      <div className="card-head">
        <span className="dot" />
        <div>
          <p className="label">Simulated {cloud} · {backend}</p>
          <h2>{kinfolk} · {cloud}</h2>
        </div>
      </div>
      {state.status === "loading" && <p>Loading timeline…</p>}
      {state.status === "error" && (
        <p>
          Couldn&apos;t reach this backend ({state.message}). Showing nothing rather than
          pretending it&apos;s empty.
        </p>
      )}
      {state.status === "empty" && (
        <p>
          No stories yet — post above or run <code>npm run post</code>.
        </p>
      )}
      {state.status === "ready" && (
        <>
          {authed && backend !== OPERATOR.backend && state.owner && (
            <ReplyBox
              label={`Write on ${kinfolk}'s wall`}
              placeholder={`Say something on ${kinfolk}'s wall`}
              target={{ to: { fingerprint: state.owner } }}
              onDone={onChanged}
            />
          )}
          {state.entries.map((e) => {
            const s = state.stories[e.id];
            const from = e.to
              ? wallLabel(authorName(e.origin, backend, contacts, kinfolk), kinfolk)
              : originLabel(e.origin, backend, contacts, kinfolk);
            const ownerPost = state.owner !== undefined && e.signer === state.owner;
            return (
              <div key={e.id} className="story">
                <p className="date">{formatDate(e.createdAt)} · verified signature{e.encrypted ? " · encrypted" : ""}{from ? ` · ${from}` : ""}</p>
                {!e.to && <h3>{e.title}</h3>}
                {s ? (s.restricted !== undefined ? <Unlocker backend={backend} id={e.id} /> : <p>{s.body}</p>) : <p>Story unavailable or failed verification for this entry.</p>}
                {e.to && <ReplyActions entry={e} canDelete={mine(e)} canHide={hideable(e, true)} onDone={onChanged} />}
                {(e.comments ?? []).length > 0 && (
                  <ul className="comments">
                    {(e.comments ?? []).map((c) => {
                      const cs = state.stories[c.id];
                      return (
                        <li key={c.id}>
                          <p className="date">
                            {authorName(c.origin, backend, contacts, kinfolk)} · {formatDate(c.createdAt)} · verified signature
                          </p>
                          <p>{cs ? cs.body : "Comment unavailable or failed verification."}</p>
                          <ReplyActions entry={c} canDelete={mine(c)} canHide={hideable(c, ownerPost)} onDone={onChanged} />
                        </li>
                      );
                    })}
                  </ul>
                )}
                {authed && e.signer && !e.sealed && (
                  <ReplyBox label="Comment" placeholder="Write a comment" target={{ inReplyTo: { fingerprint: e.signer, storyId: e.id } }} onDone={onChanged} />
                )}
                {e.sealed && <p className="date">Comments on Kinfolk-only posts are not available yet.</p>}
                <footer>
                  <code>{e.id}</code>
                </footer>
              </div>
            );
          })}
        </>
      )}
    </article>
  );
}

function useSession() {
  const [authed, setAuthed] = useState<boolean | null>(null);
  const [loginError, setLoginError] = useState("");
  useEffect(() => {
    fetch("/api/session")
      .then(async (res) => {
        const parsed = (await safeJson(res)) as { authenticated?: boolean } | null;
        setAuthed(parsed?.authenticated === true);
      })
      .catch(() => setAuthed(false));
  }, []);
  async function login(token: string): Promise<void> {
    setLoginError("");
    let res: Response;
    try {
      res = await fetch("/api/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token }),
      });
    } catch {
      setLoginError("Could not reach the server \u2014 check your connection and try again.");
      return;
    }
    if (!res.ok) {
      setLoginError("Wrong passphrase — try again.");
      return;
    }
    setAuthed(true);
  }
  async function logout(): Promise<void> {
    await fetch("/api/logout", { method: "POST" });
    setAuthed(false);
  }
  return { authed, loginError, login, logout };
}

function LoginForm({ onLogin, error }: { onLogin: (token: string) => void; error: string }) {
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState(false);
  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (busy || !token) return;
    setBusy(true);
    try {
      await onLogin(token);
    } finally {
      setBusy(false);
      setToken("");
    }
  }
  return (
    <section className="composer">
      <h2>Operator login</h2>
      <p className="lede">Posting is limited to the timeline owner. Enter the operator passphrase.</p>
      <form onSubmit={submit}>
        <input
          type="password"
          value={token}
          onChange={(e) => setToken(e.target.value)}
          placeholder="Operator passphrase"
          aria-label="Operator passphrase"
          autoComplete="current-password"
        />
        <button type="submit" disabled={busy || !token}>Log in</button>
      </form>
      {error && <p className="date">{error}</p>}
    </section>
  );
}

function useOperatorFingerprint(authed: boolean | null): string | undefined {
  // M15 #101: shows Delete on the operator's own replies. The server still
  // checks every delete against the operator's key.
  const [fp, setFp] = useState<string | undefined>(undefined);
  useEffect(() => {
    if (!authed) return;
    fetch("/api/invite")
      .then(async (res) => (res.ok ? ((await safeJson(res)) as InviteInfo | null) : null))
      .then((v) => setFp(typeof v?.fingerprint === "string" ? v.fingerprint : undefined), () => setFp(undefined));
  }, [authed]);
  return fp;
}

function App() {
  const [refresh, setRefresh] = useState(0);
  const { authed, loginError, login, logout } = useSession();
  const operatorFp = useOperatorFingerprint(authed);
  return (
    <main>
      <header>
        <p className="eyebrow">ROOTED / OWNPLACE</p>
        <h1>Your place, wherever your data lives.</h1>
        <p className="lede">
          Two Kinfolk, each on their own cloud. Each column is one porch: its
          owner's posts plus the Kinfolk they follow.
        </p>
      </header>
      <section className="boundary">
        <strong>Demo boundary</strong>
        <span>
          Timelines show only Ed25519-verified history packages — content hashes
          and signatures are checked before display. Unverified entries are
          hidden, never shown. Posts are encrypted to the author and mutual follows unless marked public (demo-grade crypto, not audited).
        </span>
      </section>
      {authed === null && <p>Checking login…</p>}
      {authed === false && <LoginForm onLogin={login} error={loginError} />}
      {authed === true && (
        <>
          <p>
            <button onClick={() => logout()}>Log out</button>
          </p>
          <Composer onPosted={() => setRefresh((n) => n + 1)} />
          <YourInvite />
          <FollowByInvite onChanged={() => setRefresh((n) => n + 1)} />
          <Contacts key={refresh} onChanged={() => setRefresh((n) => n + 1)} />
        </>
      )}
      <div className="grid">
        {PORCHES.map((p) => (
          <BackendColumn
            key={p.backend}
            backend={p.backend}
            kinfolk={p.kinfolk}
            cloud={p.cloud}
            refresh={refresh}
            authed={authed === true}
            operatorFp={operatorFp}
            onChanged={() => setRefresh((n) => n + 1)}
          />
        ))}
      </div>
    </main>
  );
}
createRoot(document.getElementById("root")!).render(
  <StrictMode>
    {/^\/i\/[0-9a-f]{64}\/?$/.test(window.location.pathname) ? <InviteLanding /> : <App />}
  </StrictMode>
);
