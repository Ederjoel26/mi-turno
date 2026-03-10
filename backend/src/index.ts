import express from "express";
import QRCode from "qrcode";

import { env } from "./config/env.js";
import { checkDbConnection, pool } from "./db/pool.js";
import { connectBaileys, getBaileysStatus } from "./services/baileys.js";

const app = express();

app.use(express.json());

app.get("/health", (_req, res) => {
  res.json({ ok: true, service: "backend", env: env.nodeEnv });
});

app.get("/db/ping", async (_req, res) => {
  try {
    const now = await checkDbConnection();
    res.json({ ok: true, now });
  } catch (error) {
    res.status(500).json({ ok: false, error: (error as Error).message });
  }
});

app.get("/baileys/status", (_req, res) => {
  res.json({ ok: true, ...getBaileysStatus() });
});

app.get("/baileys/qr", async (req, res) => {
  const status = getBaileysStatus();

  if (!status.lastQr) {
    res.status(404).json({
      ok: false,
      error: "QR not available yet. Run POST /baileys/connect first.",
    });
    return;
  }

  const format = String(req.query.format ?? "svg").toLowerCase();

  try {
    if (format === "terminal") {
      const terminalQr = await QRCode.toString(status.lastQr, {
        type: "terminal",
        small: true,
      });
      res.type("text/plain").send(terminalQr);
      return;
    }

    if (format === "raw") {
      res.json({ ok: true, qr: status.lastQr });
      return;
    }

    const svgQr = await QRCode.toString(status.lastQr, {
      type: "svg",
      margin: 1,
      width: 320,
    });
    res.type("image/svg+xml").send(svgQr);
  } catch (error) {
    res.status(500).json({ ok: false, error: (error as Error).message });
  }
});

app.post("/baileys/connect", async (_req, res) => {
  try {
    await Promise.race([
      connectBaileys(),
      new Promise((resolve) => setTimeout(resolve, 12000)),
    ]);

    const status = getBaileysStatus();

    res.json({
      ok: true,
      message: status.connected
        ? "Baileys connected"
        : "Baileys connection initialized, check /baileys/status or /baileys/qr",
      ...status,
    });
  } catch (error) {
    res.status(500).json({ ok: false, error: (error as Error).message });
  }
});

const server = app.listen(env.port, () => {
  console.log(`Backend running on http://localhost:${env.port}`);
});

if (env.baileysAutoConnect) {
  connectBaileys().catch((error) => {
    console.error("Baileys auto-connect failed:", error);
  });
}

async function shutdown(signal: string): Promise<void> {
  console.log(`Received ${signal}. Shutting down...`);
  server.close(async () => {
    await pool.end();
    process.exit(0);
  });
}

process.on("SIGINT", () => {
  void shutdown("SIGINT");
});

process.on("SIGTERM", () => {
  void shutdown("SIGTERM");
});
