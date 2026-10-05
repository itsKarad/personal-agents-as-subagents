import assert from "node:assert/strict";
import test from "node:test";
import {
  CorrelatedReplyBuffer,
  buildInstinctPrompt,
  findCorrelatedJobId,
  hasLinkedWhatsAppIdentity,
  isBoundChatJid,
  isDirectJid,
  isIncomingDirectChat,
  parseInstinctResponse,
  shouldIgnoreWhatsAppJid,
} from "./whatsapp.js";

test("task prompt uses the fixed BRIDGE markers and only selected source", () => {
  const prompt = buildInstinctPrompt("job-123", "Change the return value", ["src/value.ts"], [
    { path: "src/value.ts", contents: "export const value = 41;" },
  ]);
  assert.match(prompt, /BRIDGE_BEGIN_JOB123/);
  assert.match(prompt, /BRIDGE_DONE_JOB123/);
  assert.match(prompt, /src\/value\.ts/);
  assert.doesNotMatch(prompt, /secret\.env/);
});

test("WhatsApp replies correlate only to an expected job and parse as patch or quota", () => {
  const fence = String.fromCharCode(96).repeat(3);
  const reply = "BRIDGE_BEGIN_JOB123\n" + fence + "diff\n--- a/src/value.ts\n+++ b/src/value.ts\n@@ -1 +1 @@\n-export const value = 41;\n+export const value = 42;\n" + fence + "\nBRIDGE_DONE_JOB123";
  assert.equal(findCorrelatedJobId(reply, ["job-123"]), "job-123");
  assert.equal(findCorrelatedJobId("BRIDGE_DONE_JOB123", ["job-123"]), "job-123");
  assert.equal(findCorrelatedJobId(reply, ["job-456"]), null);
  assert.equal(parseInstinctResponse("job-123", reply).kind, "patch");
  assert.deepEqual(parseInstinctResponse("job-123", "BRIDGE_ERROR_JOB123: quota_exhausted"), {
    kind: "quota_exhausted",
    message: "quota_exhausted",
  });
});

test("split and interleaved replies stay attached to distinct job tokens", () => {
  const fence = String.fromCharCode(96).repeat(3);
  const collector = new CorrelatedReplyBuffer(new Set(["job-123", "job-456"]));
  const firstStart = `BRIDGE_BEGIN_JOB123\n${fence}diff\n+first`;
  const secondStart = `BRIDGE_BEGIN_JOB456\n${fence}diff\n+second`;
  const firstEnd = `${fence}\nBRIDGE_DONE_JOB123`;
  const secondEnd = `${fence}\nBRIDGE_DONE_JOB456`;
  assert.equal(collector.append(firstStart), null);
  assert.equal(collector.append(secondStart), null);
  const first = collector.append(firstEnd);
  const second = collector.append(secondEnd);
  assert.equal(first?.jobId, "job-123");
  assert.equal(first?.response, firstStart + firstEnd);
  assert.equal(second?.jobId, "job-456");
  assert.equal(second?.response, secondStart + secondEnd);
  assert.equal(collector.partialJobCount, 0);
});

test("only direct person chats can be bound", () => {
  assert.equal(isDirectJid("123456789@s.whatsapp.net"), true);
  assert.equal(isDirectJid("abc123@lid"), true);
  assert.equal(isDirectJid("123456@bot"), false);
  assert.equal(isDirectJid("123456@g.us"), false);
  assert.equal(isDirectJid("status@broadcast"), false);
  assert.equal(isDirectJid(null), false);
});

test("bound chat matching accepts normalized and alternate direct JIDs", () => {
  assert.equal(isBoundChatJid("123:4@lid", "123@lid"), true);
  assert.equal(isBoundChatJid("456@lid", "123@lid", "123:2@lid"), true);
  assert.equal(isBoundChatJid("456@lid", "123@lid", "789@lid"), false);
  assert.equal(shouldIgnoreWhatsAppJid("456@s.whatsapp.net"), false);
  assert.equal(shouldIgnoreWhatsAppJid("group@g.us"), true);
  assert.equal(shouldIgnoreWhatsAppJid("status@broadcast"), true);
});

test("linked companion credentials are recognized by their saved identity", () => {
  assert.equal(hasLinkedWhatsAppIdentity({ registered: false, me: { id: "123@s.whatsapp.net" } }), true);
  assert.equal(hasLinkedWhatsAppIdentity({ registered: false }), false);
});

test("chat selection considers only incoming direct replies", () => {
  assert.equal(isIncomingDirectChat("123@s.whatsapp.net", false), true);
  assert.equal(isIncomingDirectChat("123@bot", false), false);
  assert.equal(isIncomingDirectChat("123@s.whatsapp.net", true), false);
  assert.equal(isIncomingDirectChat("123@g.us", false), false);
  assert.equal(isIncomingDirectChat(null, false), false);
});
