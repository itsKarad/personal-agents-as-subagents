import { createInterface } from "node:readline/promises";
import qrcode from "qrcode-terminal";
import { config } from "../src/config.js";
import { InstinctWhatsAppSession, saveInstinctChatJid } from "../src/instinct/whatsapp.js";
import { acquireWhatsAppSessionLock } from "../src/session-lock.js";

process.umask(0o077);
let session: InstinctWhatsAppSession | null = null;
let releaseSession: (() => Promise<void>) | null = null;
let reader: ReturnType<typeof createInterface> | null = null;
let interrupted = false;
function interrupt(): void {
  if (interrupted) return;
  interrupted = true;
  reader?.close();
  void session?.close();
}
process.on("SIGINT", interrupt);
process.on("SIGTERM", interrupt);

try {
  if (!process.stdin.isTTY) throw new Error("Run WhatsApp setup in an interactive terminal so you can confirm the replying chat.");
  releaseSession = await acquireWhatsAppSessionLock(config.dataDir);
  session = await InstinctWhatsAppSession.open({
    allowUnregistered: true,
    ...(process.env.INSTINCT_BRIDGE_DEBUG === "1" ? {
      onMessageMetadata: (event: { type: string; domain: string | null; fromMe: boolean | null | undefined; hasMessage: boolean }) => {
        process.stdout.write(`Message event ${JSON.stringify(event)}\n`);
      },
    } : {}),
    onQr: (qr) => {
      process.stdout.write("\nScan this QR in WhatsApp → Settings → Linked devices → Link a device.\n");
      qrcode.generate(qr, { small: true });
    },
  });
  if (interrupted) throw new Error("Setup interrupted.");
  await session.waitUntilConnected(5 * 60_000);
  reader = createInterface({ input: process.stdin, output: process.stdout });
  reader.on("SIGINT", interrupt);
  const deadline = Date.now() + 10 * 60_000;
  let firstCandidate = true;
  while (true) {
    const candidatePromise = session.waitForChatCandidate(Math.max(0, deadline - Date.now()));
    process.stdout.write(firstCandidate
      ? "\nWhatsApp connected. Message only the Instinct chat, then wait for its text reply. This terminal will show who replied and ask you to confirm the chat.\n"
      : "\nWaiting for another direct chat reply. Send another message to the intended chat.\n");
    firstCandidate = false;
    const candidate = await candidatePromise;
    process.stdout.write(`\nIncoming reply from ${candidate.name ?? "unknown contact"} (${candidate.jid}).\n`);
    const answer = (await reader.question("Type YES to save this chat, or press Enter to ignore it: ")).trim();
    if (answer !== "YES") continue;
    await saveInstinctChatJid(candidate.jid);
    process.stdout.write(`Instinct chat saved in ${config.whatsappTargetPath}. WhatsApp setup is complete.\n`);
    break;
  }
} catch (error) {
  if (interrupted) {
    process.stderr.write("\nWhatsApp setup cancelled. No Instinct chat was saved.\n");
  } else {
    process.stderr.write(`WhatsApp setup failed: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
} finally {
  reader?.close();
  await session?.close();
  await releaseSession?.();
  if (interrupted) process.exitCode = 130;
}
