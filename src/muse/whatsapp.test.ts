import assert from "node:assert/strict";
import test from "node:test";
import {
  buildMusePrompt,
  findCorrelatedJobId,
  hasLinkedWhatsAppIdentity,
  isDirectJid,
  isIncomingDirectChat,
  parseMuseResponse,
} from "./whatsapp.js";

test("Muse prompts include only the selected source and a unique response marker", () => {
  const prompt = buildMusePrompt("job-123", "Change the return value", ["src/value.ts"], [
    { path: "src/value.ts", contents: "export const value = 41;" },
  ]);
  assert.match(prompt, /MUSE_BRIDGE_BEGIN_JOB123/);
  assert.match(prompt, /MUSE_BRIDGE_DONE_JOB123/);
  assert.match(prompt, /src\/value\.ts/);
  assert.doesNotMatch(prompt, /secret\.env/);
});

test("WhatsApp replies correlate only to an expected job and parse as patch or quota", () => {
  const reply = "MUSE_BRIDGE_BEGIN_JOB123\n```diff\n--- a/src/value.ts\n+++ b/src/value.ts\n@@ -1 +1 @@\n-export const value = 41;\n+export const value = 42;\n```\nMUSE_BRIDGE_DONE_JOB123";
  assert.equal(findCorrelatedJobId(reply, ["job-123"]), "job-123");
  assert.equal(findCorrelatedJobId(reply, ["job-456"]), null);
  assert.equal(parseMuseResponse("job-123", reply).kind, "patch");
  assert.deepEqual(parseMuseResponse("job-123", "MUSE_BRIDGE_ERROR_JOB123: quota_exhausted"), {
    kind: "quota_exhausted",
    message: "quota_exhausted",
  });
});

test("only direct WhatsApp conversations can be bound as Muse", () => {
  assert.equal(isDirectJid("123456789@s.whatsapp.net"), true);
  assert.equal(isDirectJid("abc123@lid"), true);
  assert.equal(isDirectJid("123456@bot"), true);
  assert.equal(isDirectJid("123456@g.us"), false);
  assert.equal(isDirectJid("status@broadcast"), false);
  assert.equal(isDirectJid(null), false);
});

test("linked QR companion credentials are recognized by their saved identity", () => {
  assert.equal(hasLinkedWhatsAppIdentity({ registered: false, me: { id: "123@s.whatsapp.net" } }), true);
  assert.equal(hasLinkedWhatsAppIdentity({ registered: false }), false);
});

test("chat selection considers only incoming direct replies", () => {
  assert.equal(isIncomingDirectChat("123@s.whatsapp.net", false), true);
  assert.equal(isIncomingDirectChat("123@bot", false), true);
  assert.equal(isIncomingDirectChat("123@s.whatsapp.net", true), false);
  assert.equal(isIncomingDirectChat("123@g.us", false), false);
  assert.equal(isIncomingDirectChat(null, false), false);
});
