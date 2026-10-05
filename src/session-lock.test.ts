import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { acquireWhatsAppSessionLock } from "./session-lock.js";

test("concurrent clients serialize WhatsApp sessions through the shared lock", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "instinct-session-lock-"));
  let active = 0;
  let maximumActive = 0;
  try {
    await Promise.all(Array.from({ length: 4 }, async () => {
      const release = await acquireWhatsAppSessionLock(dataDir);
      assert.ok(release);
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      await new Promise((resolve) => setTimeout(resolve, 15));
      active -= 1;
      await release();
    }));
    assert.equal(maximumActive, 1);
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});
