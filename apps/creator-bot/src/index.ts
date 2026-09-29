// Demo seed publisher. M15 #100: two Kinfolk, one cloud each.
//   Alex (kinfolk-alex) -> demo/stores/nextcloud-sim, plus the real kevcloud
//     Nextcloud (WebDavStore) only when KEVCLOUD_WEBDAV_URL/USER/PASS is set.
//   Sam (kinfolk-sam)   -> demo/stores/google-drive-sim, plus the real Google
//     Drive via rclone only when GOOGLE_DRIVE_SYNC=1.
// Each posts their own signed story through the same lane as `npm run post`,
// then each porch's contacts.json follows the other with a local: address
// pinned to the other Kinfolk's key fingerprint (M10 + M13 machinery).
// Re-running is idempotent: fixed story ids and dates, deterministic Ed25519
// signatures, and timeline/ history from `npm run post` is kept (see #41).
// Credentials: env only, never committed. Skipped clouds are reported.

import { identityFingerprint, loadOrCreateIdentity } from "@rooted/protocol";
import { LocalFolderStore } from "@rooted/storage";
import {
  DEMO_KINFOLK,
  addContact,
  backendsFromEnv,
  defaultRepoRoot,
  publishStory,
  type DemoKinfolk,
} from "@rooted/timeline";
import { resolve } from "node:path";

const SEED_STORIES: Record<string, { storyId: string; createdAt: string; title: string; body: string }> = {
  "kinfolk-alex": {
    storyId: "story-first-light",
    createdAt: "2026-09-19T09:00:00.000Z",
    title: "First light at the workshop",
    body: "A small place can hold a big beginning. Today we opened the doors, shared a meal, and made room for one another.",
  },
  "kinfolk-sam": {
    storyId: "story-garden-table",
    createdAt: "2026-09-19T10:00:00.000Z",
    title: "A table in the garden",
    body: "My porch lives on a different cloud, and you can still read it. We set a long table under the trees and kept a seat open.",
  },
};

const backends = backendsFromEnv(defaultRepoRoot());
const published: string[] = [];
const skipped = new Set<string>();

async function seed(kinfolk: DemoKinfolk): Promise<void> {
  const story = SEED_STORIES[kinfolk.id];
  const res = await publishStory(
    { title: story.title, body: story.body, media: [], authorId: kinfolk.id, authorName: kinfolk.displayName, authorBio: kinfolk.bio },
    backends,
    { storyId: story.storyId, createdAt: story.createdAt },
  );
  published.push(...res.backends.map((b) => `${b} (${kinfolk.displayName})`));
  for (const s of res.skipped) skipped.add(s);
}

for (const kinfolk of DEMO_KINFOLK) await seed(kinfolk);

// Each Kinfolk follows the other, pinned to the key that signs their posts.
for (const kinfolk of DEMO_KINFOLK) {
  const store = new LocalFolderStore(resolve(backends.root, kinfolk.porch));
  for (const other of DEMO_KINFOLK) {
    if (other.id === kinfolk.id) continue;
    await addContact(store, {
      id: other.id,
      displayName: other.displayName,
      addedAt: new Date().toISOString(),
      address: `local:${other.porch}`,
      fingerprint: identityFingerprint(loadOrCreateIdentity(other.id).publicKey),
    });
    console.log(`${kinfolk.displayName} follows ${other.displayName} (local:${other.porch})`);
  }
}

const unusedClouds = [...skipped].filter((cloud) => !published.some((p) => p.startsWith(`${cloud} `)));
console.log(`done: ${published.join(", ")}${unusedClouds.length ? `; not synced: ${unusedClouds.join(", ")}` : ""}`);
