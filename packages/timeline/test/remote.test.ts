import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HttpsPorchStore, LocalFolderStore, REMOTE_PORCH_LIMITS, isRefusedPorchHost } from "@rooted/storage";
import {
  addContact,
  publishStory,
  readContactFollowedTimeline,
  readVerifiedFollowedStory,
  validateContact,
} from "../src/index.js";

// M11 #90: serve a real signed porch folder as if it were
// https://porch.test/<name>/..., with no network. Every call is recorded
// so tests can assert what was (and was not) fetched.
function porchFetch(routes: Record<string, string>) {
  const calls: { url: string; init?: RequestInit }[] = [];
  const impl = async (url: string, init?: RequestInit): Promise<Response> => {
    calls.push({ url, init });
    for (const [prefix, dir] of Object.entries(routes)) {
      if (!url.startsWith(prefix + "/")) continue;
      const rel = decodeURIComponent(url.slice(prefix.length + 1));
      try {
        return new Response(await readFile(join(dir, rel)), { status: 200 });
      } catch {
        return new Response("not found", { status: 404 });
      }
    }
    throw new Error("unreachable host");
  };
  return { impl, calls };
}

async function withPorches(fn: (dir: string) => Promise<void>) {
  const dir = await mkdtemp(join(tmpdir(), "rooted-remote-"));
  const savedIds = process.env.OWNPLACE_IDENTITY_DIR;
  process.env.OWNPLACE_IDENTITY_DIR = join(dir, "ids");
  try {
    await publishStory(
      { title: "Own", body: "mine", authorId: "kinfolk-me", authorName: "Me" },
      { root: dir },
      { public: true, createdAt: "2026-09-28T00:00:00.000Z", storyId: "story-own-1" },
    );
    await publishStory(
      { title: "Alex 1", body: "remote one", authorId: "kinfolk-alex", authorName: "Alex" },
      { root: join(dir, "remote-alex") },
      { public: true, createdAt: "2026-09-28T00:01:00.000Z", storyId: "story-alex-1" },
    );
    await publishStory(
      { title: "Alex 2", body: "remote two", authorId: "kinfolk-alex", authorName: "Alex" },
      { root: join(dir, "remote-alex") },
      { public: true, createdAt: "2026-09-28T00:02:00.000Z", storyId: "story-alex-2" },
    );
    await fn(dir);
  } finally {
    if (savedIds === undefined) delete process.env.OWNPLACE_IDENTITY_DIR;
    else process.env.OWNPLACE_IDENTITY_DIR = savedIds;
    await rm(dir, { recursive: true, force: true });
  }
}

const now = "2026-09-28T00:05:00.000Z";

test("remote follow: https porch merges verified entries with contact origin", async () => {
  await withPorches(async (dir) => {
    await addContact(new LocalFolderStore(join(dir, "nextcloud-sim")), validateContact({
      id: "alex", displayName: "Alex", address: "https://porch.test/alex",
    }));
    const net = porchFetch({ "https://porch.test/alex": join(dir, "remote-alex/nextcloud-sim") });
    const merged = await readContactFollowedTimeline(dir, "nextcloud-sim", now, "nextcloud-sim", { fetch: net.impl });
    assert.deepEqual(merged.stories.map((s) => [s.id, s.origin]), [
      ["story-alex-2", "alex"],
      ["story-alex-1", "alex"],
      ["story-own-1", "nextcloud-sim"],
    ]);
    assert.ok(merged.stories.every((s) => s.verified));
    // GET only, never follows redirects, always time-bounded.
    assert.ok(net.calls.length > 0);
    for (const call of net.calls) {
      assert.equal(call.init?.method, "GET");
      assert.equal(call.init?.redirect, "error");
      assert.ok(call.init?.signal);
    }
    // timeline.json is fetched once per read, not once per story.
    assert.equal(net.calls.filter((c) => c.url.endsWith("/timeline.json")).length, 1);

    const opened = await readVerifiedFollowedStory(dir, "nextcloud-sim", "story-alex-2", "nextcloud-sim", { fetch: net.impl });
    assert.equal(opened.body, "remote two");
  });
});

test("remote follow: tampered remote package is skipped, the rest stay", async () => {
  await withPorches(async (dir) => {
    await addContact(new LocalFolderStore(join(dir, "nextcloud-sim")), validateContact({
      id: "alex", displayName: "Alex", address: "https://porch.test/alex",
    }));
    const remoteDir = join(dir, "remote-alex/nextcloud-sim");
    const storyPath = join(remoteDir, "timeline/story-alex-1/story.json");
    const story = JSON.parse(await readFile(storyPath, "utf8"));
    await writeFile(storyPath, JSON.stringify({ ...story, body: "forged" }));
    const net = porchFetch({ "https://porch.test/alex": remoteDir });
    const merged = await readContactFollowedTimeline(dir, "nextcloud-sim", now, "nextcloud-sim", { fetch: net.impl });
    assert.deepEqual(merged.stories.map((s) => s.id), ["story-alex-2", "story-own-1"]);
    assert.ok(merged.skipped.some((s) => s.porch === "alex" && s.id === "story-alex-1"));
    await assert.rejects(readVerifiedFollowedStory(dir, "nextcloud-sim", "story-alex-1", "nextcloud-sim", { fetch: net.impl }));
  });
});

test("remote follow: unreachable, malformed, or oversized porch loses only itself", async () => {
  await withPorches(async (dir) => {
    const own = new LocalFolderStore(join(dir, "nextcloud-sim"));
    await addContact(own, validateContact({ id: "down", displayName: "Down", address: "https://down.test/p" }));
    await addContact(own, validateContact({ id: "junk", displayName: "Junk", address: "https://junk.test/p" }));
    await addContact(own, validateContact({ id: "huge", displayName: "Huge", address: "https://huge.test/p" }));
    await addContact(own, validateContact({ id: "alex", displayName: "Alex", address: "https://porch.test/alex" }));
    const net = porchFetch({ "https://porch.test/alex": join(dir, "remote-alex/nextcloud-sim") });
    const fetchImpl = async (url: string, init?: RequestInit): Promise<Response> => {
      if (url.startsWith("https://down.test/")) throw new Error("ECONNREFUSED 10.1.2.3:443");
      if (url.startsWith("https://junk.test/")) return new Response("<html>not json</html>", { status: 200 });
      if (url.startsWith("https://huge.test/")) {
        // No content-length: the streaming cap must catch it.
        const chunk = new Uint8Array(64 * 1024).fill(32);
        let sent = 0;
        return new Response(new ReadableStream({
          pull(controller) {
            if (sent > REMOTE_PORCH_LIMITS.maxBytes * 2) return controller.close();
            sent += chunk.byteLength;
            controller.enqueue(chunk);
          },
        }), { status: 200 });
      }
      return net.impl(url, init);
    };
    const merged = await readContactFollowedTimeline(dir, "nextcloud-sim", now, "nextcloud-sim", { fetch: fetchImpl });
    assert.deepEqual(merged.stories.map((s) => s.id), ["story-alex-2", "story-alex-1", "story-own-1"]);
    for (const porch of ["down", "junk", "huge"]) {
      assert.ok(merged.skipped.some((s) => s.porch === porch && s.reason === "porch unreadable"), porch);
    }
    // Raw network errors never reach the public shape.
    assert.ok(!JSON.stringify(merged).includes("ECONNREFUSED"));
    assert.ok(!JSON.stringify(merged).includes("10.1.2.3"));
    // A down porch does not block opening a story from a later porch.
    const opened = await readVerifiedFollowedStory(dir, "nextcloud-sim", "story-alex-1", "nextcloud-sim", { fetch: fetchImpl });
    assert.equal(opened.body, "remote one");
  });
});

test("remote follow: private and local hosts are refused without a fetch", async () => {
  await withPorches(async (dir) => {
    const own = new LocalFolderStore(join(dir, "nextcloud-sim"));
    const refused = ["https://127.0.0.1/p", "https://10.0.0.5/p", "https://192.168.1.9/p", "https://localhost/p", "https://agent0/p"];
    for (const [i, address] of refused.entries()) {
      await addContact(own, validateContact({ id: `bad${i}`, displayName: "Bad", address }));
    }
    const net = porchFetch({});
    const merged = await readContactFollowedTimeline(dir, "nextcloud-sim", now, "nextcloud-sim", { fetch: net.impl });
    assert.deepEqual(merged.stories.map((s) => s.id), ["story-own-1"]);
    assert.equal(net.calls.length, 0);
    for (let i = 0; i < refused.length; i++) {
      assert.ok(merged.skipped.some((s) => s.porch === `bad${i}` && s.reason === "remote porch refused"), refused[i]);
    }
  });
});

test("remote follow: timeline hint is capped and unsafe ids dropped", async () => {
  const stories = [
    { id: "../escape" }, { id: "ok-1" }, { id: "ok-1" }, { id: 7 }, null,
    ...Array.from({ length: 80 }, (_, i) => ({ id: `s-${i}` })),
  ];
  const store = new HttpsPorchStore("https://porch.test/x", {
    fetch: async () => new Response(JSON.stringify({ stories }), { status: 200 }),
  });
  const listed = await store.listObjects("timeline/");
  const ids = [...new Set(listed.map((p) => p.split("/")[1]))];
  assert.equal(ids.length, REMOTE_PORCH_LIMITS.maxStories);
  assert.equal(ids[0], "ok-1");
  assert.ok(!ids.some((id) => id.includes("..")));
  // Size cap: declared length and undeclared streams both fail closed.
  const big = new Uint8Array(REMOTE_PORCH_LIMITS.maxBytes + 1).fill(32);
  const declared = new HttpsPorchStore("https://porch.test/x", {
    fetch: async () => new Response("{}", { status: 200, headers: { "content-length": String(big.byteLength) } }),
  });
  await assert.rejects(declared.readObject("timeline/a/story.json"), /too large/);
  const streamed = new HttpsPorchStore("https://porch.test/x", {
    fetch: async () => new Response(new ReadableStream({ start(c) { c.enqueue(big); c.close(); } }), { status: 200 }),
  });
  await assert.rejects(streamed.readObject("timeline/a/story.json"), /too large/);
  const exact = new HttpsPorchStore("https://porch.test/x", {
    fetch: async () => new Response(big.subarray(1), { status: 200 }),
  });
  assert.equal((await exact.readObject("timeline/a/story.json")).byteLength, REMOTE_PORCH_LIMITS.maxBytes);
  await assert.rejects(store.writeObject("timeline/x/story.json", new Uint8Array()), /read-only/);
  await assert.rejects(store.deleteObject("timeline/x/story.json"), /read-only/);
});

test("remote porch host and address checks", () => {
  for (const host of ["127.0.0.1", "10.2.3.4", "172.16.0.1", "172.31.255.255", "192.168.0.1", "169.254.1.1",
    "100.64.0.1", "100.127.1.1", "0.0.0.0", "localhost", "a.localhost", "agent0", "1.2.3"]) {
    assert.equal(isRefusedPorchHost(host), true, host);
  }
  for (const host of ["porch.example.com", "8.8.8.8", "172.32.0.1", "100.128.0.1", "my-porch.ts.net"]) {
    assert.equal(isRefusedPorchHost(host), false, host);
  }
  assert.throws(() => new HttpsPorchStore("http://porch.test/x"), /https/);
  assert.throws(() => new HttpsPorchStore("https://u:p@porch.test/x"), /extra parts/);
  assert.throws(() => new HttpsPorchStore("https://porch.test/x?q=1"), /extra parts/);
  assert.throws(() => new HttpsPorchStore("https://[::1]/x"), /refused/);
});
