// Demo seed publisher. M15 #100: two Kinfolk, one cloud each.
//   Alex (kinfolk-alex) -> demo/stores/nextcloud-sim, plus the real kevcloud
//     Nextcloud (WebDavStore) only when KEVCLOUD_WEBDAV_URL/USER/PASS is set.
//   Sam (kinfolk-sam)   -> demo/stores/google-drive-sim, plus the real Google
//     Drive via rclone only when GOOGLE_DRIVE_SYNC=1.
// Each porch's contacts.json follows the other with a local: address pinned
// to the other Kinfolk's key fingerprint (M10 + M13 machinery). M16 #116:
// then each posts one encrypted story through the same lane as `npm run
// post`, and each re-wraps their epoch key once both have posted, so the
// mutual pair can read each other.
// Re-running is idempotent: fixed opaque story ids, a seed story already on
// its porch is kept (not re-encrypted), and timeline/ history from `npm run
// post` is kept (see #41).
// Credentials: env only, never committed. Skipped clouds are reported.

import { identityFingerprint, loadOrCreateIdentity } from "@rooted/protocol";
import { LocalFolderStore } from "@rooted/storage";
import {
  DEMO_KINFOLK,
  addContact,
  backendsFromEnv,
  defaultRepoRoot,
  fetchSignedPackage,
  publishStory,
  refreshKeyWraps,
  requireOperatorSettings,
  type DemoKinfolk,
} from "@rooted/timeline";
import { resolve } from "node:path";

// M15 #111: invalid OWNPLACE_OPERATOR_* settings refuse startup. Seed
// stories are keyed by porch, so a renamed operator still seeds their porch.
// M16 #116: seed ids are opaque; the title and date live in the ciphertext.
requireOperatorSettings();

const SEED_STORIES: Record<DemoKinfolk["porch"], { storyId: string; createdAt: string; title: string; body: string }> = {
  "nextcloud-sim": {
    storyId: "story-6b1f0e9a4c2d47d8a35e1c7f90b2d4e6",
    createdAt: "2026-09-19T09:00:00.000Z",
    title: "First light at the workshop",
    body: "A small place can hold a big beginning. Today we opened the doors, shared a meal, and made room for one another.",
  },
  "google-drive-sim": {
    storyId: "story-c83d5a17e2f94b06b9d1a4e7f3c50a28",
    createdAt: "2026-09-19T10:00:00.000Z",
    title: "A table in the garden",
    body: "My porch lives on a different cloud, and you can still read it. We set a long table under the trees and kept a seat open.",
  },
};

const backends = backendsFromEnv(defaultRepoRoot());
const published: string[] = [];
const skipped = new Set<string>();

async function alreadySeeded(kinfolk: DemoKinfolk, storyId: string): Promise<boolean> {
  try {
    const pkg = await fetchSignedPackage(new LocalFolderStore(resolve(backends.root, kinfolk.porch)), storyId);
    return pkg.kinfolk.publicKey === loadOrCreateIdentity(kinfolk.id).publicKey &&
      pkg.kinfolk.displayName === kinfolk.displayName && pkg.kinfolk.bio === kinfolk.bio;
  } catch {
    return false;
  }
}

async function seed(kinfolk: DemoKinfolk): Promise<void> {
  const story = SEED_STORIES[kinfolk.porch];
  if (await alreadySeeded(kinfolk, story.storyId)) {
    console.log(`${kinfolk.displayName}'s seed story is already on ${kinfolk.porch}`);
    return;
  }
  const res = await publishStory(
    { title: story.title, body: story.body, media: [], authorId: kinfolk.id, authorName: kinfolk.displayName, authorBio: kinfolk.bio },
    backends,
    { storyId: story.storyId, createdAt: story.createdAt },
  );
  published.push(...res.backends.map((b) => `${b} (${kinfolk.displayName})`));
  for (const s of res.skipped) skipped.add(s);
}

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

for (const kinfolk of DEMO_KINFOLK) await seed(kinfolk);

// M16 #116: the first to post could not see the other's encryption key yet.
for (const kinfolk of DEMO_KINFOLK) {
  const res = await refreshKeyWraps(kinfolk.id, backends);
  published.push(...res.backends.map((b) => `${b} (${kinfolk.displayName})`));
  for (const s of res.skipped) skipped.add(s);
}

const unusedClouds = [...skipped].filter((cloud) => !published.some((p) => p.startsWith(`${cloud} `)));
console.log(`done: ${[...new Set(published)].join(", ")}${unusedClouds.length ? `; not synced: ${unusedClouds.join(", ")}` : ""}`);
