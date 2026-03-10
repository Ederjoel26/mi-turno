import express from "express";
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

app.post("/baileys/connect", async (_req, res) => {
  try {
    await connectBaileys();
    res.json({
      ok: true,
      message: "Baileys connection initialized",
      ...getBaileysStatus(),
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
