import type { WASocket } from "@whiskeysockets/baileys";
import { createAppointmentAtomic, getAvailableSlots } from "./booking.js";
import {
  DEFAULT_TENANT_ID,
  getTenantName,
  getServices,
  getProviders,
  getOrCreateSession,
  updateSession,
  getNextAvailableDays,
  getAppointmentsByPhone,
  type SessionPayload,
} from "./whatsapp-db.js";

// Inicializa el handler de WhatsApp - escucha mensajes entrantes
export function setupWhatsAppHandler(sock: WASocket): void {
  sock.ev.on("messages.upsert", async ({ messages, type }) => {
    if (type !== "notify") return;

    for (const msg of messages) {
      if (!msg.message || msg.key.fromMe) continue;

      const jid = msg.key.remoteJid;
      if (!jid) continue;

      const text =
        msg.message.conversation || msg.message.extendedTextMessage?.text || "";

      if (!text) continue;

      const phone = jid.split("@")[0];
      const lower = text.toLowerCase().trim();

      if (lower === "*") {
        await updateSession(phone, "menu", {});
        const name = await getTenantName();
        await sock.sendMessage(jid, {
          text: `👋 Bienvenido a *${name}*

          1. 📅 Agendar cita
          2. 📋 Mis citas`,
        });
        continue;
      }

      const response = await handleMessage(phone, text.trim());

      await sock.sendMessage(jid, { text: response });
    }
  });
}

// Maneja el mensaje según el estado actual de la conversación
async function handleMessage(phone: string, text: string): Promise<string> {
  const session = await getOrCreateSession(phone);

  const waPhone = `+${phone}`;

  switch (session.state) {
    case "init":
    case "menu":
      return handleMenu(text, phone);

    case "choose_service":
      return handleChooseService(text, phone, session.payload);

    case "choose_barber":
      return handleChooseBarber(text, phone, session.payload);

    case "choose_slot":
      return handleChooseSlot(text, phone, session.payload);

    case "ask_name":
      return handleAskName(text, phone, session.payload);

    case "confirm":
      return handleConfirm(text, phone, session.payload, waPhone);

    default:
      await updateSession(phone, "menu", {});
      return "Escribe * para volver al menú.";
  }
}

// Muestra el menú principal (agendar o ver citas)
async function handleMenu(text: string, phone: string): Promise<string> {
  const name = await getTenantName();

  if (text === "1") {
    const services = await getServices();

    if (!services.length) {
      return "No hay servicios disponibles.";
    }

    await updateSession(phone, "choose_service", {});

    let msg = "📅 *Selecciona servicio*\n\n";

    services.forEach((s, i) => {
      const price = s.price_cents ? `$${(s.price_cents / 100).toFixed(0)}` : "";

      msg += `${i + 1}. ${s.name} (${s.duration_minutes}min) ${price}\n`;
    });

    return msg;
  }

  if (text === "2") {
    return showAppointments(phone);
  }

  return `👋 Bienvenido a *${name}*

1. 📅 Agendar cita
2. 📋 Mis citas`;
}

// Usuario elige un servicio, muestra barberos o días disponibles
async function handleChooseService(
  text: string,
  phone: string,
  payload: SessionPayload,
) {
  const services = await getServices();
  const index = Number(text) - 1;

  if (!services[index]) return "Selecciona un servicio válido.";

  const service = services[index];

  const barbers = await getProviders(service.id);

  if (!barbers.length) {
    return "No hay barberos disponibles para ese servicio.";
  }

  if (barbers.length === 1) {
    const barber = barbers[0];

    const days = await getNextAvailableDays(
      barber.id,
      service.duration_minutes || 30,
    );

    if (!days.length) {
      return "No hay disponibilidad en los próximos días.";
    }

    await updateSession(phone, "choose_slot", {
      serviceId: service.id,
      serviceName: service.name,
      serviceDurationMinutes: service.duration_minutes,
      barberId: barber.id,
      barberName: barber.name,
    });

    let msg = `✂️ *${service.name}*\n`;
    msg += `👤 ${barber.name}\n\n`;
    msg += `📅 *Selecciona día*\n\n`;

    days.forEach((d, i) => {
      const label = formatDayLabel(d);
      msg += `${i + 1}. ${label}\n`;
    });

    msg += `\nO escribe una fecha (YYYY-MM-DD)`;

    return msg;
  }

  await updateSession(phone, "choose_barber", {
    serviceId: service.id,
    serviceName: service.name,
    serviceDurationMinutes: service.duration_minutes,
  });

  let msg = `✂️ *${service.name}*\n\nSelecciona barbero:\n\n`;

  barbers.forEach((b, i) => {
    msg += `${i + 1}. ${b.name}\n`;
  });

  return msg;
}

// Usuario elige barbero, muestra días disponibles
async function handleChooseBarber(
  text: string,
  phone: string,
  payload: SessionPayload,
) {
  const barbers = await getProviders(payload.serviceId!);
  const index = Number(text) - 1;

  if (!barbers[index]) return "Selecciona un barbero válido.";

  const barber = barbers[index];

  const days = await getNextAvailableDays(
    barber.id,
    payload.serviceDurationMinutes || 30,
  );

  if (!days.length) {
    return "No hay disponibilidad en los próximos días.";
  }

  await updateSession(phone, "choose_slot", {
    ...payload,
    barberId: barber.id,
    barberName: barber.name,
  });

  let msg = `📅 *Selecciona día*\n\n`;

  days.forEach((d, i) => {
    const label = formatDayLabel(d);
    msg += `${i + 1}. ${label}\n`;
  });

  msg += `\nO escribe una fecha (YYYY-MM-DD)`;

  return msg;
}

// Elige día (1ra fase) o horario (2da fase)
async function handleChooseSlot(
  text: string,
  phone: string,
  payload: SessionPayload,
) {
  const dateRegex = /^\d{4}-\d{2}-\d{2}$/;

  if (!payload.date) {
    const days = await getNextAvailableDays(
      payload.barberId!,
      payload.serviceDurationMinutes || 30,
    );

    let selectedDate = "";
    const index = Number(text) - 1;

    if (!isNaN(index) && days[index]) {
      selectedDate = days[index];
    } else if (dateRegex.test(text)) {
      selectedDate = text;
    } else {
      return "Selecciona un día válido.";
    }

    const slots = await getAvailableSlots({
      tenantId: DEFAULT_TENANT_ID,
      providerId: payload.barberId!,
      date: selectedDate,
      timezone: "America/Mexico_City",
      serviceDurationMinutes: payload.serviceDurationMinutes || 30,
      slotStepMinutes: 30,
    });

    if (!slots.length) {
      return "No hay horarios disponibles ese día.";
    }

    await updateSession(phone, "choose_slot", {
      ...payload,
      date: selectedDate,
    });

    let msg = `⏰ *Horarios disponibles*\n\n`;

    slots.slice(0, 8).forEach((s, i) => {
      const time = new Date(s.startsAt).toLocaleTimeString("es-MX", {
        hour: "2-digit",
        minute: "2-digit",
      });

      msg += `${i + 1}. ${time}\n`;
    });

    return msg;
  }

  const slots = await getAvailableSlots({
    tenantId: DEFAULT_TENANT_ID,
    providerId: payload.barberId!,
    date: payload.date,
    timezone: "America/Mexico_City",
    serviceDurationMinutes: payload.serviceDurationMinutes || 30,
    slotStepMinutes: 30,
  });

  const index = Number(text) - 1;

  if (!slots[index]) return "Selecciona horario válido.";

  const slot = slots[index];

  await updateSession(phone, "ask_name", {
    ...payload,
    slotStartsAt: slot.startsAt,
    slotEndsAt: slot.endsAt,
  });

  return "Escribe tu nombre:";
}

// Pide el nombre del cliente antes de confirmar
async function handleAskName(
  text: string,
  phone: string,
  payload: SessionPayload,
) {
  if (text.length < 2) return "Escribe tu nombre completo.";

  await updateSession(phone, "confirm", {
    ...payload,
    customerName: text,
  });

  const date = new Date(payload.slotStartsAt!).toLocaleString("es-MX", {
    weekday: "long",
    day: "numeric",
    month: "long",
    hour: "2-digit",
    minute: "2-digit",
  });

  return `📋 *Confirma tu cita*

Servicio: ${payload.serviceName}
Barbero: ${payload.barberName}
Fecha: ${date}
Nombre: ${text}

Responde:
1 para confirmar
2 para cancelar`;
}

// Confirma o cancela la cita
async function handleConfirm(
  text: string,
  phone: string,
  payload: SessionPayload,
  waPhone: string,
) {
  if (text === "1") {
    const appointment = await createAppointmentAtomic({
      tenantId: DEFAULT_TENANT_ID,
      providerId: payload.barberId!,
      serviceId: payload.serviceId!,
      startsAt: payload.slotStartsAt!,
      durationMinutes: payload.serviceDurationMinutes!,
      customerPhoneE164: waPhone,
      customerName: payload.customerName!,
      createdBy: "bot",
    });

    await updateSession(phone, "done", {});

    return `✅ Cita confirmada

Te esperamos en la barbería 💈`;
  }

  await updateSession(phone, "menu", {});

  return "❌ Cita cancelada.\n\nEscribe * para volver al menú.";
}

// Muestra las citas agendadas del cliente
async function showAppointments(phone: string) {
  const rows = await getAppointmentsByPhone(phone);

  if (!rows.length) return "📋 No tienes citas.";

  let msg = "📋 *Tus citas:*\n\n";

  rows.forEach((r, i) => {
    const date = new Date(r.starts_at).toLocaleString("es-MX", {
      weekday: "short",
      day: "numeric",
      month: "short",
      hour: "2-digit",
      minute: "2-digit",
      timeZone: "America/Mexico_City",
    });

    msg += `${i + 1}. 📅 ${date}\n   ${r.service} con ${r.provider}\n\n`;
  });

  msg += "Escribe * para volver al menú.";

  return msg;
}

// Formatea la fecha para mostrar "Hoy", "Mañana" o "Vie 13 Mar"
function formatDayLabel(dateStr: string): string {
  const d = new Date(dateStr + "T00:00:00");
  const weekdays = ["Dom", "Lun", "Mar", "Mié", "Jue", "Vie", "Sáb"];
  const months = [
    "Ene",
    "Feb",
    "Mar",
    "Abr",
    "May",
    "Jun",
    "Jul",
    "Ago",
    "Sep",
    "Oct",
    "Nov",
    "Dic",
  ];

  const weekday = weekdays[d.getDay()];
  const day = d.getDate();
  const month = months[d.getMonth()];

  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const targetDate = new Date(dateStr + "T00:00:00");
  targetDate.setHours(0, 0, 0, 0);

  const diffDays = Math.round(
    (targetDate.getTime() - today.getTime()) / (1000 * 60 * 60 * 24),
  );

  if (diffDays === 0) return `Hoy - ${weekday} ${day}`;
  if (diffDays === 1) return `Mañana - ${weekday} ${day}`;

  return `${weekday} ${day} ${month}`;
}
