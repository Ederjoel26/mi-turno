import {
  DisconnectReason,
  fetchLatestBaileysVersion,
  makeWASocket,
  type WASocket,
  useMultiFileAuthState,
} from "@whiskeysockets/baileys";
import { rm } from "node:fs/promises";
import { env } from "../config/env.js";

type BaileysStatus = {
  connected: boolean;
  connecting: boolean;
  lastQr: string | null;
  lastPairingCode: string | null;
  pairingCodeExpiresAt: string | null;
  lastDisconnectReason: string | null;
};

const status: BaileysStatus = {
  connected: false,
  connecting: false,
  lastQr: null,
  lastPairingCode: null,
  pairingCodeExpiresAt: null,
  lastDisconnectReason: null,
};

let connectingPromise: Promise<void> | null = null;
let sock: WASocket | null = null;

function getStatusCode(error: unknown): number | undefined {
  return (error as { output?: { statusCode?: number } } | undefined)?.output
    ?.statusCode;
}

export function getBaileysStatus(): BaileysStatus {
  if (
    status.pairingCodeExpiresAt &&
    Date.now() > Date.parse(status.pairingCodeExpiresAt)
  ) {
    status.lastPairingCode = null;
    status.pairingCodeExpiresAt = null;
  }

  return { ...status };
}

function toWhatsappJid(phoneE164: string): string {
  const digits = phoneE164.replace(/[^\d]/g, "");

  if (!digits) {
    throw new Error("Invalid WhatsApp phone number");
  }

  return `${digits}@s.whatsapp.net`;
}

function toWhatsappDigits(phoneE164: string): string {
  const digits = phoneE164.replace(/[^\d]/g, "");

  if (!digits) {
    throw new Error("Invalid WhatsApp phone number");
  }

  return digits;
}

export async function sendWhatsAppText(
  phoneE164: string,
  text: string,
): Promise<void> {
  if (!sock || !status.connected) {
    throw new Error("Baileys is not connected");
  }

  await sock.sendMessage(toWhatsappJid(phoneE164), { text });
}

export async function connectBaileys(): Promise<void> {
  if (status.connected || sock) return;

  if (connectingPromise) return connectingPromise;

  connectingPromise = (async () => {
    status.connecting = true;
    status.lastDisconnectReason = null;

    const { state, saveCreds } = await useMultiFileAuthState(
      env.baileysAuthDir,
    );
    const { version } = await fetchLatestBaileysVersion();

    sock = makeWASocket({
      version,
      auth: state,
    });

    sock.ev.on("creds.update", saveCreds);

    sock.ev.on("connection.update", (update) => {
      const { connection, lastDisconnect, qr } = update;
      console.log(
        "connection",
        connection,
        "lastDisconnect",
        lastDisconnect,
        "qr",
        qr,
      );
      if (qr) status.lastQr = qr;

      if (connection === "open") {
        status.connected = true;
        status.connecting = false;
        status.lastQr = null;
        status.lastPairingCode = null;
        status.pairingCodeExpiresAt = null;
      }

      if (connection === "close") {
        status.connected = false;
        status.connecting = false;
        sock = null;
        status.lastPairingCode = null;
        status.pairingCodeExpiresAt = null;

        const statusCode = getStatusCode(lastDisconnect?.error);

        status.lastDisconnectReason =
          statusCode === DisconnectReason.loggedOut
            ? "logged_out"
            : statusCode
              ? `disconnected_${statusCode}`
              : "disconnected";

        if (statusCode !== DisconnectReason.loggedOut) {
          setTimeout(() => {
            void connectBaileys();
          }, 2000);
        }
      }
    });
  })()
    .catch((error) => {
      status.connected = false;
      status.connecting = false;
      sock = null;
      status.lastDisconnectReason = (error as Error).message;
      console.error("Baileys connect error:", error);
    })
    .finally(() => {
      connectingPromise = null;
    });

  return connectingPromise;
}

export async function requestBaileysPairingCode(
  phoneE164: string,
): Promise<{ pairingCode: string; expiresAt: string }> {
  if (status.connected) {
    throw new Error("Baileys is already connected");
  }

  await connectBaileys();

  const activeSocket = sock as
    | (WASocket & {
        requestPairingCode?: (phoneNumber: string) => Promise<string>;
      })
    | null;

  if (!activeSocket?.requestPairingCode) {
    throw new Error("Pairing code is not available for this connection");
  }

  const pairingCode = await activeSocket.requestPairingCode(
    toWhatsappDigits(phoneE164),
  );

  const expiresAt = new Date(
    Date.now() + env.baileysPairingCodeTtlSeconds * 1000,
  ).toISOString();

  status.lastPairingCode = pairingCode;
  status.pairingCodeExpiresAt = expiresAt;
  status.lastQr = null;

  return { pairingCode, expiresAt };
}

export async function reconnectBaileys(clearAuth: boolean): Promise<void> {
  await disconnectBaileys(clearAuth);
  await connectBaileys();
}

export async function disconnectBaileys(clearAuth: boolean): Promise<void> {
  if (sock) {
    try {
      await sock.logout();
    } catch (error) {
      status.lastDisconnectReason = (error as Error).message;
    }
  }

  sock = null;
  status.connected = false;
  status.connecting = false;
  status.lastQr = null;
  status.lastPairingCode = null;
  status.pairingCodeExpiresAt = null;

  if (clearAuth) {
    await rm(env.baileysAuthDir, { recursive: true, force: true });
    status.lastDisconnectReason = "session_cleared";
  }
}
