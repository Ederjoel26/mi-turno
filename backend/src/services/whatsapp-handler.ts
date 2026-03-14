import type { WASocket } from "@whiskeysockets/baileys";
import { pool } from "../db/pool.js";
import {
  getAvailableSlots,
  createAppointmentAtomic,
  DomainValidationError,
  SlotConflictError,
} from "./booking.js";

const DEFAULT_TENANT_ID = "f1388aa9-a443-4326-805d-c1ca7ef090a6";

type SessionPayload = {
  serviceId?: string;
  serviceName?: string;
  providerId?: string;
  providerName?: string;
  serviceDurationMinutes?: number;
  date?: string;
  slotIndex?: number;
  slotStartsAt?: string;
  slotEndsAt?: string;
  customerName?: string;
  appointments?: Array<{
    id: string;
    starts_at: string;
    service_name: string;
    provider_name: string;
  }>;
};

export function setupWhatsAppHandler(sock: WASocket): void {
  sock.ev.on("messages.upsert", async ({ messages, type }) => {
    if (type !== "notify") return;

    for (const msg of messages) {
      if (!msg.message || msg.key.fromMe) continue;

      const jid = msg.key.remoteJid;
      if (!jid || (!jid.endsWith("@s.whatsapp.net") && !jid.endsWith("@lid")))
        continue;

      const text =
        msg.message.conversation || msg.message.extendedTextMessage?.text || "";
      if (!text) continue;

      const lowerText = text.toLowerCase().trim();

      if (lowerText === "*") {
        await resetSession(jid.split("@")[0]);
        await sock.sendMessage(jid, {
          text: "🔄 Sesión reiniciada.\n\n¡Hola! 👋\nBienvenido a *La Barbería*\n\n¿Qué deseas hacer?\n1. 📅 Agendar cita\n2. 📋 Mis citas",
        });
        continue;
      }

      console.log(`[WA] Mensaje de ${jid}: ${text}`);
      await handleMessage(jid, text.trim(), sock);
    }
  });
}

async function handleMessage(
  jid: string,
  text: string,
  sock: WASocket,
): Promise<void> {
  const phone = jid.split("@")[0];
  const waPhoneE164 = `+${phone}`;

  const session = await getOrCreateSession(phone);

  let response = "";

  try {
    switch (session.state) {
      case "init":
      case "menu":
        response = await handleMenu(text, phone);
        break;

      case "choose_service":
        response = await handleChooseService(text, phone, session.payload);
        break;

      case "choose_provider":
        response = await handleChooseProvider(text, phone, session.payload);
        break;

      case "choose_date":
        response = await handleChooseDate(text, phone, session.payload);
        break;

      case "choose_slot":
        response = await handleChooseSlot(text, phone, session.payload);
        break;

      case "ask_name":
        response = await handleAskName(text, phone, session.payload);
        break;

      case "confirm":
        response = await handleConfirm(
          text,
          phone,
          session.payload,
          waPhoneE164,
        );
        break;

      case "show_appointments":
        response = await handleShowAppointments(text, phone, session.payload);
        break;

      default:
        await updateSession(phone, "init", {});
        response = "Sesión reiniciada. Escribe * para empezar.";
    }
  } catch (error) {
    console.error("[WA] Error handling message:", error);
    response = "Ocurrió un error. Escribe * para reiniciar.";
    await updateSession(phone, "init", {});
  }

  await sock.sendMessage(jid, { text: response });
}

async function handleMenu(text: string, phone: string): Promise<string> {
  const lowerText = text.toLowerCase().trim();

  if (lowerText === "1" || lowerText.includes("agendar")) {
    const services = await getServices(DEFAULT_TENANT_ID);
    console.log(services);
    if (services.length === 0) {
      return "No hay servicios disponibles en este momento.";
    }

    const payload: SessionPayload = {
      serviceId: services[0].id,
      serviceName: services[0].name,
      serviceDurationMinutes: services[0].duration_minutes,
    };
    await updateSession(phone, "choose_service", payload);

    let msg = "📅 *Agenda tu cita*\n\n";
    msg += "Selecciona el servicio:\n\n";
    services.forEach((s, i) => {
      const price = s.price_cents ? `$${(s.price_cents / 100).toFixed(0)}` : "";
      const duration = `${s.duration_minutes}min`;
      msg += `${i + 1}. ${s.name} - ${duration} ${price ? `- ${price}MXN` : ""}\n`;
    });
    msg += "\nEscribe el número:";
    return msg;
  }

  if (lowerText === "2" || lowerText.includes("mis citas")) {
    return await showMyAppointments(phone, "show_appointments");
  }

  return `¡Hola! 👋\nBienvenido a *La Barbería*\n\n¿Qué deseas hacer?\n1. 📅 Agendar cita\n2. 📋 Mis citas\n\nEscribe el número de opción:`;
}

async function handleChooseService(
  text: string,
  phone: string,
  payload: SessionPayload,
): Promise<string> {
  const services = await getServices(DEFAULT_TENANT_ID);
  const index = parseInt(text.trim()) - 1;

  if (isNaN(index) || index < 0 || index >= services.length) {
    return "Selección inválida. Escribe el número del servicio:";
  }

  const service = services[index];
  const providers = await getProvidersForService(DEFAULT_TENANT_ID, service.id);

  if (providers.length === 0) {
    await updateSession(phone, "init", {});
    return "No hay barberos disponibles para este servicio.";
  }

  const newPayload: SessionPayload = {
    ...payload,
    serviceId: service.id,
    serviceName: service.name,
    serviceDurationMinutes: service.duration_minutes,
  };
  await updateSession(phone, "choose_provider", newPayload);

  let msg = `✅ *${service.name}* (${service.duration_minutes}min)\n\n`;
  msg += "Selecciona el barbero:\n\n";
  providers.forEach((p, i) => {
    msg += `${i + 1}. ${p.name}\n`;
  });
  msg += "\nEscribe el número:";

  return msg;
}

async function handleChooseProvider(
  text: string,
  phone: string,
  payload: SessionPayload,
): Promise<string> {
  const services = await getServices(DEFAULT_TENANT_ID);
  const service = services.find((s) => s.id === payload.serviceId);
  if (!service) {
    await updateSession(phone, "init", {});
    return "Sesión expirada. Escribe * para empezar de nuevo.";
  }

  const providers = await getProvidersForService(DEFAULT_TENANT_ID, service.id);
  const index = parseInt(text.trim()) - 1;

  if (isNaN(index) || index < 0 || index >= providers.length) {
    return "Selección inválida. Escribe el número del barbero:";
  }

  const provider = providers[index];
  const newPayload: SessionPayload = {
    ...payload,
    providerId: provider.id,
    providerName: provider.name,
  };
  await updateSession(phone, "choose_date", newPayload);

  const today = new Date();
  const tomorrow = new Date(today);
  tomorrow.setDate(tomorrow.getDate() + 1);
  const nextWeek = new Date(today);
  nextWeek.setDate(nextWeek.getDate() + 7);

  const formatDate = (d: Date) => d.toISOString().split("T")[0];

  return `✅ *${service.name}* con *${provider.name}*\n\n`;
}

async function handleChooseDate(
  text: string,
  phone: string,
  payload: SessionPayload,
): Promise<string> {
  const dateRegex = /^\d{4}-\d{2}-\d{2}$/;
  let date = text.trim();

  if (!dateRegex.test(date)) {
    return "Formato inválido. Escribe la fecha en formato YYYY-MM-DD\nEjemplo: 2026-03-15";
  }

  const parsedDate = new Date(`${date}T12:00:00.000Z`);
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  if (parsedDate < today) {
    return "No puedes agendar en fechas pasadas. Escribe una fecha válida (YYYY-MM-DD):";
  }

  const weekday = parsedDate.getUTCDay();
  if (weekday === 0) {
    return "No atendemos domingos. Elige otro día (YYYY-MM-DD):";
  }

  const slots = await getAvailableSlots({
    tenantId: DEFAULT_TENANT_ID,
    providerId: payload.providerId!,
    date,
    timezone: "America/Mexico_City",
    serviceDurationMinutes: payload.serviceDurationMinutes || 30,
    slotStepMinutes: 30,
  });

  if (slots.length === 0) {
    return "No hay horarios disponibles para esa fecha. Elige otra fecha (YYYY-MM-DD):";
  }

  const newPayload: SessionPayload = { ...payload, date };
  await updateSession(phone, "choose_slot", newPayload);

  return await formatSlotsResponse(slots, date);
}

async function formatSlotsResponse(
  slots: Array<{ startsAt: string; endsAt: string }>,
  date: string,
): Promise<string> {
  const slotsText = slots
    .slice(0, 8)
    .map((s, i) => {
      const time = new Date(s.startsAt).toLocaleTimeString("es-MX", {
        hour: "2-digit",
        minute: "2-digit",
        timeZone: "America/Mexico_City",
      });
      return `${i + 1}. ${time}`;
    })
    .join("\n");

  return `📅 *${date}*\n\nHorarios disponibles:\n${slotsText}\n\n${slots.length > 8 ? `... y ${slots.length - 8} más` : ""}\nEscribe el número del horario:`;
}

async function handleChooseSlot(
  text: string,
  phone: string,
  payload: SessionPayload,
): Promise<string> {
  const slots = await getAvailableSlots({
    tenantId: DEFAULT_TENANT_ID,
    providerId: payload.providerId!,
    date: payload.date!,
    timezone: "America/Mexico_City",
    serviceDurationMinutes: payload.serviceDurationMinutes || 30,
    slotStepMinutes: 30,
  });

  const index = parseInt(text.trim()) - 1;

  if (isNaN(index) || index < 0 || index >= slots.length) {
    return "Selección inválida. Escribe el número del horario:";
  }

  const slot = slots[index];
  const newPayload: SessionPayload = {
    ...payload,
    slotIndex: index,
    slotStartsAt: slot.startsAt,
    slotEndsAt: slot.endsAt,
  };
  await updateSession(phone, "ask_name", newPayload);

  const dateTime = new Date(slot.startsAt).toLocaleString("es-MX", {
    weekday: "long",
    day: "numeric",
    month: "long",
    hour: "2-digit",
    minute: "2-digit",
    timeZone: "America/Mexico_City",
  });

  return `📋 *Confirma tu cita*\n\n`;
}

async function handleAskName(
  text: string,
  phone: string,
  payload: SessionPayload,
): Promise<string> {
  const customerName = text.trim();

  if (customerName.length < 2) {
    return "Por favor ingresa tu nombre completo:";
  }

  const newPayload: SessionPayload = { ...payload, customerName };
  await updateSession(phone, "confirm", newPayload);

  const dateTime = new Date(payload.slotStartsAt!).toLocaleString("es-MX", {
    weekday: "long",
    day: "numeric",
    month: "long",
    hour: "2-digit",
    minute: "2-digit",
    timeZone: "America/Mexico_City",
  });

  return `📋 *Confirma tu cita*\n\n`;
}

async function handleConfirm(
  text: string,
  phone: string,
  payload: SessionPayload,
  waPhoneE164: string,
): Promise<string> {
  const lowerText = text.toLowerCase().trim();

  if (
    lowerText === "si" ||
    lowerText === "sí" ||
    lowerText === "1" ||
    lowerText === "confirmar" ||
    lowerText === "y" ||
    lowerText === "yes"
  ) {
    try {
      const appointment = await createAppointmentAtomic({
        tenantId: DEFAULT_TENANT_ID,
        providerId: payload.providerId!,
        serviceId: payload.serviceId!,
        startsAt: payload.slotStartsAt!,
        durationMinutes: payload.serviceDurationMinutes || 30,
        customerPhoneE164: waPhoneE164,
        customerName: payload.customerName!,
        createdBy: "bot",
      });

      await updateSession(phone, "init", {});

      const dateTime = new Date(appointment.startsAt).toLocaleString("es-MX", {
        weekday: "long",
        day: "numeric",
        month: "long",
        hour: "2-digit",
        minute: "2-digit",
        timeZone: "America/Mexico_City",
      });

      return `✅ *Cita Confirmada!*\n\n`;
    } catch (error) {
      console.error("[WA] Error creating appointment:", error);
      if (error instanceof SlotConflictError) {
        return "❌ El horario ya no está disponible. Escribe * para empezar de nuevo.";
      }
      return "❌ No se pudo agendar la cita. Escribe * para intentar de nuevo.";
    }
  }

  if (lowerText === "no" || lowerText === "cancelar" || lowerText === "c") {
    await updateSession(phone, "init", {});
    return "❌ Cita cancelada.\n\n¿Algo más? Escribe:\n1. 📅 Agendar cita\n2. 📋 Mis citas";
  }

  return "Responde *sí* para confirmar o *no* para cancelar:";
}

async function showMyAppointments(
  phone: string,
  newState: string = "menu",
): Promise<string> {
  const waPhoneE164 = `+${phone}`;

  const result = await pool.query<{
    id: string;
    starts_at: Date;
    status: string;
    service_name: string;
    provider_name: string;
  }>(
    `SELECT a.id, a.starts_at, a.status, s.name as service_name, p.name as provider_name
     FROM appointments a
     JOIN services s ON s.id = a.service_id
     JOIN providers p ON p.id = a.provider_id
     JOIN customers c ON c.id = a.customer_id
     WHERE c.wa_phone_e164 = $1 AND a.status IN ('pending', 'confirmed')
     ORDER BY a.starts_at ASC
     LIMIT 5`,
    [waPhoneE164],
  );

  if (result.rows.length === 0) {
    if (newState === "show_appointments") {
      await updateSession(phone, "menu", {});
    }
    return "📋 No tienes citas agendadas.\n\n¿Deseas agendar una?\n1. 📅 Agendar cita\n2. 📋 Mis citas";
  }

  const appointments = result.rows.map((row) => ({
    id: row.id,
    starts_at: row.starts_at.toISOString(),
    service_name: row.service_name,
    provider_name: row.provider_name,
  }));

  let msg = "📋 *Tus citas:*\n\n";
  result.rows.forEach((row, i) => {
    const dateTime = new Date(row.starts_at).toLocaleString("es-MX", {
      weekday: "short",
      day: "numeric",
      month: "short",
      hour: "2-digit",
      minute: "2-digit",
      timeZone: "America/Mexico_City",
    });
    msg += `${i + 1}. 📅 ${dateTime}\n   ${row.service_name} con ${row.provider_name}\n\n`;
  });

  msg += "Escribe * para volver al menú.";

  if (newState === "show_appointments") {
    await updateSession(phone, "show_appointments", { appointments });
  }

  return msg;
}

async function handleShowAppointments(
  text: string,
  phone: string,
  payload: SessionPayload,
): Promise<string> {
  const lowerText = text.toLowerCase().trim();

  if (lowerText === "*" || lowerText === "menu" || lowerText === "volver") {
    await updateSession(phone, "menu", {});
    return "✅\n\n¿Qué deseas hacer?\n1. 📅 Agendar cita\n2. 📋 Mis citas";
  }

  return showMyAppointments(phone, "show_appointments");
}

async function resetSession(phone: string): Promise<void> {
  await updateSession(phone, "init", {});
}

async function getServices(tenantId: string) {
  const result = await pool.query<{
    id: string;
    name: string;
    price_cents: number | null;
    duration_minutes: number;
  }>(
    "SELECT id, name, price_cents, duration_minutes FROM services WHERE tenant_id = $1 AND is_active = TRUE ORDER BY name",
    [tenantId],
  );
  return result.rows;
}

async function getProvidersForService(tenantId: string, serviceId: string) {
  const result = await pool.query<{ id: string; name: string }>(
    `SELECT p.id, p.name 
     FROM providers p
     JOIN provider_services ps ON ps.provider_id = p.id
     WHERE p.tenant_id = $1 AND ps.service_id = $2 AND p.is_active = TRUE
     ORDER BY p.name`,
    [tenantId, serviceId],
  );
  return result.rows;
}

async function getOrCreateSession(phone: string) {
  const res = await pool.query(
    `INSERT INTO conversation_sessions (tenant_id, wa_phone_e164, state, payload)
     VALUES ($1, $2, 'init', '{}')
     ON CONFLICT (tenant_id, wa_phone_e164) DO UPDATE SET updated_at = NOW()
     RETURNING state, payload`,
    [DEFAULT_TENANT_ID, phone],
  );
  return res.rows[0];
}

async function updateSession(
  phone: string,
  state: string,
  payload: SessionPayload,
) {
  await pool.query(
    `UPDATE conversation_sessions SET state = $1, payload = $2 
     WHERE wa_phone_e164 = $3 AND tenant_id = $4`,
    [state, JSON.stringify(payload), phone, DEFAULT_TENANT_ID],
  );
}
