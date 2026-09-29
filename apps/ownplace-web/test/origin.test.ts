import test from "node:test";
import assert from "node:assert/strict";
import { authorName, originLabel, wallLabel } from "../src/origin.js";

test("origin label names your porch, a followed display name, or the raw origin", () => {
  const contacts = [{ id: "porch-alex", displayName: "Alex" }];
  assert.equal(originLabel(undefined, "nextcloud-sim", contacts), null);
  assert.equal(originLabel("nextcloud-sim", "nextcloud-sim", contacts), "Your porch");
  assert.equal(originLabel("porch-alex", "nextcloud-sim", contacts), "From Alex");
  assert.equal(originLabel("porch-sam", "nextcloud-sim", contacts), "From porch-sam");
});

test("origin label names the column owner's porch when given (#100)", () => {
  const contacts = [{ id: "kinfolk-alex", displayName: "Alex Rowan" }];
  assert.equal(originLabel("google-drive-sim", "google-drive-sim", contacts, "Sam"), "Sam's porch");
  assert.equal(originLabel("kinfolk-alex", "google-drive-sim", contacts, "Sam"), "From Alex Rowan");
});

test("reply labels name the author by origin and the wall by column owner (#101)", () => {
  const contacts = [{ id: "kinfolk-sam", displayName: "Sam" }];
  assert.equal(authorName("kinfolk-sam", "nextcloud-sim", contacts, "Alex"), "Sam");
  assert.equal(authorName("nextcloud-sim", "nextcloud-sim", contacts, "Alex"), "Alex");
  assert.equal(authorName(undefined, "nextcloud-sim", contacts, "Alex"), "Alex");
  assert.equal(authorName("porch-jo", "nextcloud-sim", contacts, "Alex"), "porch-jo");
  assert.equal(wallLabel("Sam", "Alex"), "Sam → Alex's wall");
});
