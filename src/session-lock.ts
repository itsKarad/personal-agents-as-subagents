import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, stat, unlink } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

function processIsAlive(pid: number): boolean {
  if (pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

export async function acquireWhatsAppSessionLock(
  dataDir: string,
  shouldCancel: () => boolean = () => false,
): Promise<(() => Promise<void>) | null> {
  const lockPath = join(dataDir, "whatsapp-session.lock");
  await mkdir(dataDir, { recursive: true, mode: 0o700 });
  const token = randomUUID();
  while (!shouldCancel()) {
    try {
      const handle = await open(lockPath, "wx", 0o600);
      try {
        await handle.writeFile(JSON.stringify({ pid: process.pid, token }));
      } finally {
        await handle.close();
      }
      return async () => {
        try {
          const owner = JSON.parse(await readFile(lockPath, "utf8")) as { token?: string };
          if (owner.token === token) await unlink(lockPath);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      try {
        const raw = await readFile(lockPath, "utf8");
        const owner = JSON.parse(raw) as { pid?: number };
        if (!processIsAlive(owner.pid ?? 0) && await readFile(lockPath, "utf8") === raw) {
          await unlink(lockPath);
        }
      } catch (readError) {
        if ((readError as NodeJS.ErrnoException).code !== "ENOENT") {
          const age = Date.now() - (await stat(lockPath)).mtimeMs;
          if (age > 5_000) await unlink(lockPath).catch(() => undefined);
        }
      }
      await delay(250);
    }
  }
  return null;
}
