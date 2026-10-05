import assert from "node:assert/strict";
import test from "node:test";
import { classifyRunnerError } from "./runner.js";
import { WhatsAppBridgeError } from "./instinct/whatsapp.js";

test("WhatsApp reply timeouts preserve their actionable failure classification", () => {
  assert.deepEqual(
    classifyRunnerError(new WhatsAppBridgeError("reply_timeout", "No correlated reply.")),
    { code: "reply_timeout", message: "No correlated reply.", status: "needs_user_attention" },
  );
});

test("unexpected job errors remain failed", () => {
  assert.deepEqual(
    classifyRunnerError(new Error("unexpected")),
    { code: "job_failed", message: "unexpected", status: "failed" },
  );
});
