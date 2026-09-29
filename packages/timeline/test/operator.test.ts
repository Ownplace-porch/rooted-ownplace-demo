// M15 #111: each OwnPlace copy can name its own operator Kinfolk.
import test from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_OPERATOR,
  DEMO_KINFOLK,
  OPERATOR_KINFOLK,
  OPERATOR_SETTINGS_ERRORS,
  resolveOperator,
} from "@rooted/timeline";

test("no operator settings means Alex, as today (#111)", () => {
  assert.deepEqual(resolveOperator({}), {
    id: "kinfolk-alex",
    displayName: "Alex Rowan",
    bio: "Building a more rooted internet.",
    porch: "nextcloud-sim",
    cloud: "kevcloud",
  });
  assert.deepEqual(resolveOperator({}), DEFAULT_OPERATOR);
  // The test process sets no OWNPLACE_OPERATOR_* variables.
  assert.equal(OPERATOR_KINFOLK, "kinfolk-alex");
  assert.deepEqual(DEMO_KINFOLK.map((k) => k.id), ["kinfolk-alex", "kinfolk-sam"]);
});

test("operator settings replace id, name and bio but keep the porch and cloud (#111)", () => {
  const jordan = resolveOperator({
    OWNPLACE_OPERATOR_ID: "kinfolk-jordan",
    OWNPLACE_OPERATOR_NAME: "  Jordan  ",
    OWNPLACE_OPERATOR_BIO: " Joined by QR code. ",
  });
  assert.deepEqual(jordan, {
    id: "kinfolk-jordan",
    displayName: "Jordan",
    bio: "Joined by QR code.",
    porch: "nextcloud-sim",
    cloud: "kevcloud",
  });
  // Each setting is optional on its own.
  assert.equal(resolveOperator({ OWNPLACE_OPERATOR_NAME: "Jordan" }).id, "kinfolk-alex");
  assert.equal(resolveOperator({ OWNPLACE_OPERATOR_ID: "kinfolk-jordan" }).displayName, "Alex Rowan");
  assert.equal(resolveOperator({ OWNPLACE_OPERATOR_NAME: "x".repeat(120) }).displayName.length, 120);
  assert.equal(resolveOperator({ OWNPLACE_OPERATOR_BIO: "b".repeat(500) }).bio.length, 500);
});

test("invalid operator settings are refused with fixed messages (#111)", () => {
  const refuses = (env: Record<string, string>, message: string) => {
    assert.throws(() => resolveOperator(env), (e: Error) => {
      assert.equal(e.message, message);
      for (const value of Object.values(env)) {
        // kinfolk-sam is named by the fixed message itself.
        if (value.trim() && value !== "kinfolk-sam") assert.ok(!e.message.includes(value.trim()), "message echoed the setting");
      }
      return true;
    }, JSON.stringify(env));
  };
  for (const id of ["", " kinfolk-jordan", "kinfolk/jordan", "..", "a..b", "-jordan", "kinfolk jordan", "kinfolk-sam"]) {
    refuses({ OWNPLACE_OPERATOR_ID: id }, OPERATOR_SETTINGS_ERRORS.id);
  }
  for (const name of ["", "   ", "x".repeat(121), ` ${"x".repeat(121)} `]) {
    refuses({ OWNPLACE_OPERATOR_NAME: name }, OPERATOR_SETTINGS_ERRORS.name);
  }
  refuses({ OWNPLACE_OPERATOR_BIO: "b".repeat(501) }, OPERATOR_SETTINGS_ERRORS.bio);
});
