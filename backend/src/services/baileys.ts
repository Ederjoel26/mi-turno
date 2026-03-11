import {
  DisconnectReason,
  fetchLatestBaileysVersion,
  makeWASocket,
  type WASocket,
  useMultiFileAuthState,
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
  lastDisconnectReason: null,
};

let connectingPromise: Promise<void> | null = null;
let sock: WASocket | null = null;

function getStatusCode(error: unknown): number | undefined {
  return (error as { output?: { statusCode?: number } } | undefined)?.output
    ?.statusCode;
}

export function getBaileysStatus(): BaileysStatus {
  return { ...status };
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
      }

      if (connection === "close") {
        status.connected = false;
        status.connecting = false;
        sock = null;

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
