import {
  DisconnectReason,
  fetchLatestBaileysVersion,
  makeWASocket,
  useMultiFileAuthState
} from "@whiskeysockets/baileys";
import { env } from "../config/env.js";

type BaileysStatus = {
  connected: boolean;
  connecting: boolean;
  lastQr: string | null;
  lastDisconnectReason: string | null;
};

const status: BaileysStatus = {
  connected: false,
  connecting: false,
  lastQr: null,
  lastDisconnectReason: null
};

let connectingPromise: Promise<void> | null = null;

export function getBaileysStatus(): BaileysStatus {
  return { ...status };
}

export async function connectBaileys(): Promise<void> {
  if (connectingPromise) return connectingPromise;

  connectingPromise = (async () => {
    status.connecting = true;
    status.lastDisconnectReason = null;

    const { state, saveCreds } = await useMultiFileAuthState(env.baileysAuthDir);
    const { version } = await fetchLatestBaileysVersion();

    const sock = makeWASocket({
      version,
      auth: state
    });

    sock.ev.on("creds.update", saveCreds);

    sock.ev.on("connection.update", (update) => {
      if (update.qr) {
        status.lastQr = update.qr;
      }

      if (update.connection === "open") {
        status.connected = true;
        status.connecting = false;
        status.lastQr = null;
      }

      if (update.connection === "close") {
        status.connected = false;
        status.connecting = false;

        const statusCode = (update.lastDisconnect?.error as { output?: { statusCode?: number } } | undefined)
          ?.output?.statusCode;

        status.lastDisconnectReason =
          statusCode === DisconnectReason.loggedOut ? "logged_out" : "disconnected";
      }
    });
  })().finally(() => {
    connectingPromise = null;
  });

  return connectingPromise;
}
