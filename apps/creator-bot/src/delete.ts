// M15 #101: an author deletes their own comment or wall post from their own
// porch (and that porch's cloud). Readers stop showing it on their next read.
// Plain posts are not deletable in this slice.

import { backendsFromEnv, defaultRepoRoot, deleteReply, demoKinfolkFor, NO_PORCH } from "@rooted/timeline";

function arg(name: string): string | undefined {
  const idx = process.argv.indexOf(`--${name}`);
  if (idx < 0) return undefined;
  const value = process.argv[idx + 1];
  if (value === undefined || value.startsWith("--")) return undefined;
  return value;
}

const USAGE = "usage: npm run delete-reply -- --id STORY_ID [--author-id kinfolk-alex|kinfolk-sam]";

function fail(message: string): never {
  console.error(`delete failed: ${message}`);
  console.error(USAGE);
  process.exit(2);
}

const authorId = arg("author-id") ?? "kinfolk-alex";
const id = arg("id");
if (!id) fail("--id is required");
if (!demoKinfolkFor(authorId)) fail(NO_PORCH);
try {
  const res = await deleteReply(authorId, id, backendsFromEnv(defaultRepoRoot()));
  console.log(`done: deleted ${res.storyId} from ${res.backends.join(", ")}`);
} catch (e) {
  fail((e as Error).message);
}
