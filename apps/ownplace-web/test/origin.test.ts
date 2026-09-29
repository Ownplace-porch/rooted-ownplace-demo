import test from "node:test";
import assert from "node:assert/strict";
import { originLabel } from "../src/origin.js";

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
