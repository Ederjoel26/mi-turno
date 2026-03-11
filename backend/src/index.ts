import express from "express";
import QRCode from "qrcode";

import { env } from "./config/env.js";
import { checkDbConnection, pool } from "./db/pool.js";
import {
  AppointmentNotFoundError,
  DomainValidationError,
  SlotConflictError,
  cancelAppointment,
  createAppointmentAtomic,
  getAvailableSlots,
} from "./services/booking.js";
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

app.get("/availability", async (req, res) => {
  const tenantId = String(req.query.tenantId ?? "").trim();
  const providerId = String(req.query.providerId ?? "").trim();
  const date = String(req.query.date ?? "").trim();
  const timezone = String(req.query.timezone ?? "America/Mexico_City").trim();
  const durationMinutes = Number(req.query.durationMinutes ?? 0);
  const slotStepMinutes = req.query.slotStepMinutes
    ? Number(req.query.slotStepMinutes)
    : undefined;

  if (!tenantId || !providerId || !date || !durationMinutes) {
    res.status(400).json({
      ok: false,
      error:
        "Missing required query params: tenantId, providerId, date, durationMinutes",
    });
    return;
  }

  try {
    const slots = await getAvailableSlots({
      tenantId,
      providerId,
      date,
      timezone,
      serviceDurationMinutes: durationMinutes,
      slotStepMinutes,
    });

    res.json({ ok: true, count: slots.length, slots });
  } catch (error) {
    if (error instanceof DomainValidationError) {
      res.status(400).json({ ok: false, error: error.message });
      return;
    }

    res.status(500).json({ ok: false, error: (error as Error).message });
  }
});

app.post("/appointments", async (req, res) => {
  const {
    tenantId,
    providerId,
    serviceId,
    startsAt,
    durationMinutes,
    customerPhoneE164,
    customerName,
    notes,
  } = req.body as {
    tenantId?: string;
    providerId?: string;
    serviceId?: string | null;
    startsAt?: string;
    durationMinutes?: number;
    customerPhoneE164?: string;
    customerName?: string;
    notes?: string;
  };

  if (
    !tenantId ||
    !providerId ||
    !startsAt ||
    !durationMinutes ||
    !customerPhoneE164 ||
    !customerName
  ) {
    res.status(400).json({
      ok: false,
      error:
        "Missing required body fields: tenantId, providerId, startsAt, durationMinutes, customerPhoneE164, customerName",
    });
    return;
  }

  try {
    const appointment = await createAppointmentAtomic({
      tenantId,
      providerId,
      serviceId: serviceId ?? null,
      startsAt,
      durationMinutes,
      customerPhoneE164,
      customerName,
      notes,
      createdBy: "bot",
    });

    res.status(201).json({ ok: true, appointment });
  } catch (error) {
    if (error instanceof DomainValidationError) {
      res.status(400).json({ ok: false, error: error.message });
      return;
    }

    if (error instanceof SlotConflictError) {
      res.status(409).json({ ok: false, error: error.message });
      return;
    }

    res.status(500).json({ ok: false, error: (error as Error).message });
  }
});

app.post("/appointments/:appointmentId/cancel", async (req, res) => {
  const appointmentId = String(req.params.appointmentId ?? "").trim();
  const tenantId = String(req.body?.tenantId ?? "").trim();
  const reason =
    typeof req.body?.reason === "string" ? req.body.reason.trim() : undefined;

  if (!appointmentId || !tenantId) {
    res.status(400).json({
      ok: false,
      error:
        "Missing required fields: appointmentId param and tenantId in body",
    });
    return;
  }

  try {
    const appointment = await cancelAppointment(
      tenantId,
      appointmentId,
      reason,
    );
    res.json({ ok: true, appointment });
  } catch (error) {
    if (error instanceof AppointmentNotFoundError) {
      res.status(404).json({ ok: false, error: error.message });
      return;
    }

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
    connectBaileys();

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
