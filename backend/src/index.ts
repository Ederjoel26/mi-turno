import cors from "cors";
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
import {
  connectBaileys,
  disconnectBaileys,
  getBaileysStatus,
  reconnectBaileys,
  requestBaileysPairingCode,
} from "./services/baileys.js";
import {
  startReminderWorker,
  stopReminderWorker,
} from "./services/reminder-worker.js";

const app = express();

app.use(express.json());
app.use(
  cors({
    origin: env.frontendOrigin,
  }),
);

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

app.get("/baileys/onboarding", (_req, res) => {
  const html = `<!doctype html>
<html lang="es">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Mi Turno - Vincular WhatsApp</title>
    <style>
      :root {
        color-scheme: light;
        --bg: #f3eee2;
        --card: #fffaf0;
        --ink: #1f2937;
        --muted: #4b5563;
        --brand: #007a4d;
        --accent: #d97706;
        --line: #d1d5db;
      }

      * {
        box-sizing: border-box;
      }

      body {
        margin: 0;
        min-height: 100vh;
        font-family: "Segoe UI", Tahoma, Geneva, Verdana, sans-serif;
        background:
          radial-gradient(circle at top right, #ffe4c7, transparent 45%),
          radial-gradient(circle at bottom left, #d5f5e3, transparent 35%),
          var(--bg);
        color: var(--ink);
        display: grid;
        place-items: center;
        padding: 24px;
      }

      .card {
        width: min(460px, 100%);
        background: var(--card);
        border: 1px solid var(--line);
        border-radius: 18px;
        padding: 20px;
        box-shadow: 0 12px 32px rgba(31, 41, 55, 0.14);
      }

      h1 {
        margin: 0;
        font-size: 1.45rem;
        line-height: 1.2;
      }

      p {
        margin: 10px 0 0;
        color: var(--muted);
      }

      .qr-wrap {
        margin-top: 16px;
        border: 1px dashed var(--line);
        border-radius: 14px;
        min-height: 340px;
        display: grid;
        place-items: center;
        background: white;
        padding: 16px;
      }

      #qr {
        width: min(320px, 100%);
        height: auto;
        display: none;
      }

      #status {
        margin-top: 14px;
        font-weight: 700;
        color: var(--brand);
      }

      .hint {
        margin-top: 10px;
        font-size: 0.92rem;
      }

      .small {
        margin-top: 14px;
        font-size: 0.85rem;
      }

      .ok {
        color: var(--brand);
      }

      .warn {
        color: var(--accent);
      }
    </style>
  </head>
  <body>
    <main class="card">
      <h1>Vincular WhatsApp del barbero</h1>
      <p>Escanea este QR desde WhatsApp en el telefono principal del barbero.</p>

      <div class="qr-wrap">
        <img id="qr" alt="QR para vincular WhatsApp" />
        <p id="loading">Preparando QR...</p>
      </div>

      <p id="status">Inicializando conexion...</p>
      <p class="hint">Si no podes usar segunda pantalla, pedi codigo de vinculacion por API.</p>
      <p class="small">Endpoint util: <code>POST /baileys/pairing-code</code></p>
    </main>

    <script>
      const qrImg = document.getElementById("qr");
      const loading = document.getElementById("loading");
      const statusText = document.getElementById("status");

      async function startConnection() {
        await fetch("/baileys/connect", { method: "POST" });
      }

      async function refreshStatus() {
        const response = await fetch("/baileys/status");
        const status = await response.json();

        if (status.connected) {
          qrImg.style.display = "none";
          loading.textContent = "WhatsApp conectado.";
          loading.className = "ok";
          statusText.textContent = "Listo: el numero quedo vinculado.";
          statusText.className = "ok";
          return;
        }

        if (status.lastQr) {
          qrImg.src = "/baileys/qr?format=svg&t=" + Date.now();
          qrImg.style.display = "block";
          loading.textContent = "Escanea el QR para completar el alta.";
          loading.className = "";
          statusText.textContent = "Esperando escaneo...";
          statusText.className = "warn";
          return;
        }

        qrImg.style.display = "none";
        loading.textContent = "Generando nuevo QR...";
        loading.className = "";
        statusText.textContent = "Esperando QR...";
        statusText.className = "warn";
      }

      async function bootstrap() {
        try {
          await startConnection();
          await refreshStatus();
          setInterval(refreshStatus, 2500);
        } catch (_error) {
          statusText.textContent = "No se pudo iniciar la conexion.";
          statusText.className = "warn";
        }
      }

      bootstrap();
    </script>
  </body>
</html>`;

  res.type("text/html").send(html);
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

app.post("/baileys/pairing-code", async (req, res) => {
  const phoneE164 = String(req.body?.phoneE164 ?? "").trim();

  if (!phoneE164) {
    res.status(400).json({
      ok: false,
      error: "Missing required body field: phoneE164",
    });
    return;
  }

  try {
    const { pairingCode, expiresAt } = await requestBaileysPairingCode(phoneE164);
    res.json({
      ok: true,
      pairingCode,
      expiresAt,
      message:
        "Enter this code in WhatsApp > Linked Devices > Link with phone number",
    });
  } catch (error) {
    const message = (error as Error).message;
    const statusCode =
      message === "Baileys is already connected" ||
      message === "Invalid WhatsApp phone number"
        ? 400
        : 500;
    res.status(statusCode).json({ ok: false, error: message });
  }
});

app.post("/baileys/reconnect", async (req, res) => {
  const clearAuth = Boolean(req.body?.clearAuth);

  try {
    await reconnectBaileys(clearAuth);
    res.json({
      ok: true,
      message: clearAuth
        ? "Baileys reconnected with a fresh session"
        : "Baileys reconnected",
      ...getBaileysStatus(),
    });
  } catch (error) {
    res.status(500).json({ ok: false, error: (error as Error).message });
  }
});

app.post("/baileys/disconnect", async (req, res) => {
  const clearAuth = Boolean(req.body?.clearAuth);

  try {
    await disconnectBaileys(clearAuth);
    res.json({
      ok: true,
      message: clearAuth
        ? "Baileys disconnected and auth cleared"
        : "Baileys disconnected",
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

if (env.reminderWorkerEnabled) {
  startReminderWorker();
}

async function shutdown(signal: string): Promise<void> {
  console.log(`Received ${signal}. Shutting down...`);
  server.close(async () => {
    await stopReminderWorker();
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
