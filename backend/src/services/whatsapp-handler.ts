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
  getPendingAppointmentsCount,
  type SessionPayload,
} from "./whatsapp-db.js";
import {
  parseNaturalLanguage,
  findServiceByName,
  findBarberByName,
  isTimeSlotAvailable,
  matchPartialTimeSlot,
  parseNumericSelection,
  isAffirmativeResponse,
  isNegativeResponse,
  hasBarberPreferenceAny,
  type ParsedIntent,
} from "./nlu.js";
import { cancelAppointmentById } from "./whatsapp-db.js";

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

const MAX_PENDING_APPOINTMENTS = 2;

async function checkAppointmentLimit(
  phone: string,
): Promise<{ allowed: boolean; message?: string }> {
  const count = await getPendingAppointmentsCount(phone);
  if (count >= MAX_PENDING_APPOINTMENTS) {
    return {
      allowed: false,
      message: `❌ Ya tienes ${count} citas pendientes.\n\nCancela una cita antes de agendar una nueva.\n\nEscribe * para volver al menú.`,
    };
  }
  return { allowed: true };
}

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

async function handleMenu(text: string, phone: string): Promise<string> {
  const name = await getTenantName();
  const lower = text.toLowerCase().trim();
  const parsed = parseNaturalLanguage(text);

  if (parsed.intent === "greeting") {
    return `👋 ¡Hola! Soy tu asistente de *${name}*

¿Podría beneficiarse de su ayuda?

1. 📅 Agendar cita
2. 📋 Ver mis citas`;
  }

  if (parsed.intent === "view_appointments") {
    return showAppointments(phone);
  }

  if (parsed.intent === "cancel") {
    await updateSession(phone, "menu", {});
    return "Para cancelar una cita, escribe * y luego selecciona 'Ver mis citas' para encontrar el número de referencia.";
  }

  if (parsed.intent === "availability") {
    return handleAvailabilityQuery(phone, parsed.date);
  }

  if (parsed.intent === "book") {
    return handleNaturalBooking(phone, parsed);
  }

  if (
    lower === "agendar" ||
    lower === "reservar" ||
    lower === "reservar cita" ||
    lower === "agendar cita"
  ) {
    return handleNaturalBooking(phone, { intent: "book" });
  }

  const numericChoice = parseNumericSelection(text, 2);
  if (numericChoice !== null) {
    if (numericChoice === 1) {
      const limitCheck = await checkAppointmentLimit(phone);
      if (!limitCheck.allowed) {
        return limitCheck.message!;
      }

      const services = await getServices();

      if (!services.length) {
        return "No hay servicios disponibles.";
      }

      await updateSession(phone, "choose_service", {});

      let msg = "📅 *Selecciona servicio*\n\n";

      services.forEach((s, i) => {
        const price = s.price_cents
          ? `$${(s.price_cents / 100).toFixed(0)}`
          : "";

        msg += `${i + 1}. ${s.name} (${s.duration_minutes}min) ${price}\n`;
      });

      return msg;
    }

    if (numericChoice === 2) {
      return showAppointments(phone);
    }
  }

  return `👋 Bienvenido a *${name}*

1. 📅 Agendar cita
2. 📋 Ver mis citas`;
}

async function handleNaturalBooking(
  phone: string,
  parsed: ParsedIntent,
): Promise<string> {
  const limitCheck = await checkAppointmentLimit(phone);
  if (!limitCheck.allowed) {
    return limitCheck.message!;
  }

  const services = await getServices();

  if (!services.length) {
    return "No hay servicios disponibles.";
  }

  let selectedService = parsed.serviceName
    ? (findServiceByName(services, parsed.serviceName) ?? undefined)
    : undefined;

  if (!selectedService && services.length === 1) {
    selectedService = services[0].id;
  }

  const selectedServiceObj = selectedService
    ? services.find((s) => s.id === selectedService)
    : null;

  const barbers = selectedService ? await getProviders(selectedService) : [];

  let selectedBarber = parsed.barberName
    ? (findBarberByName(barbers, parsed.barberName) ?? undefined)
    : undefined;

  if (!selectedBarber && barbers.length === 1) {
    selectedBarber = barbers[0].id;
  }

  const selectedBarberObj = selectedBarber
    ? barbers.find((b) => b.id === selectedBarber)
    : null;

  const missing: string[] = [];
  if (!selectedService) missing.push("servicio");
  if (!selectedBarber) missing.push("barbero");
  if (!parsed.date) missing.push("fecha");
  if (!parsed.time) missing.push("hora");

  if (missing.length === 0 && selectedService && selectedBarber) {
    return confirmNaturalBooking(
      phone,
      selectedService,
      selectedBarber,
      parsed.date!,
      parsed.time!,
      parsed.customerName,
    );
  }

  if (
    missing.length === 1 &&
    missing[0] === "hora" &&
    selectedService &&
    selectedBarber &&
    parsed.date
  ) {
    return handleNaturalTimeSelection(
      phone,
      selectedService,
      selectedBarber,
      parsed.date,
      parsed.customerName,
    );
  }

  if (missing.includes("servicio")) {
    await updateSession(phone, "choose_service", {
      pendingNaturalDate: parsed.date,
      pendingNaturalTime: parsed.time,
      pendingNaturalName: parsed.customerName,
      pendingNaturalBarberName: parsed.barberName,
    });

    let msg = "📅 *Selecciona servicio*\n\n";

    services.forEach((s, i) => {
      const price = s.price_cents ? `$${(s.price_cents / 100).toFixed(0)}` : "";
      msg += `${i + 1}. ${s.name} (${s.duration_minutes}min) ${price}\n`;
    });

    if (parsed.barberName || parsed.date || parsed.time) {
      msg += `\n_Para tu cita${parsed.date ? ` del ${formatNaturalDate(parsed.date)}` : ""}${parsed.time ? ` a las ${parsed.time}` : ""}${parsed.barberName ? ` con ${parsed.barberName}` : ""}_`;
    }

    return msg;
  }

  if (missing.includes("barbero") && barbers.length > 1) {
    const serviceObj = services.find((s) => s.id === selectedService)!;

    await updateSession(phone, "choose_barber", {
      serviceId: selectedService,
      serviceName: serviceObj.name,
      serviceDurationMinutes: serviceObj.duration_minutes,
      pendingNaturalDate: parsed.date,
      pendingNaturalTime: parsed.time,
      pendingNaturalName: parsed.customerName,
    });

    let msg = `✂️ *${serviceObj.name}*\n\nSelecciona barbero:\n\n`;

    barbers.forEach((b, i) => {
      msg += `${i + 1}. ${b.name}\n`;
    });

    if (parsed.date || parsed.time) {
      msg += `\n_Para tu cita${parsed.date ? ` del ${formatNaturalDate(parsed.date)}` : ""}${parsed.time ? ` a las ${parsed.time}` : ""}_`;
    }

    return msg;
  }

  if (missing.includes("fecha") || missing.includes("hora")) {
    if (!selectedBarber) {
      selectedBarber = barbers[0]?.id;
      if (!selectedBarber) {
        return "No hay barberos disponibles para ese servicio.";
      }
    }

    const serviceObj = services.find((s) => s.id === selectedService)!;
    const barberObj = barbers.find((b) => b.id === selectedBarber)!;

    const days = await getNextAvailableDays(
      selectedBarber,
      serviceObj.duration_minutes || 30,
    );

    if (!days.length) {
      return "No hay disponibilidad en los próximos días.";
    }

    await updateSession(phone, "choose_slot", {
      serviceId: selectedService,
      serviceName: serviceObj.name,
      serviceDurationMinutes: serviceObj.duration_minutes,
      barberId: selectedBarber,
      barberName: barberObj.name,
      pendingNaturalTime: parsed.time,
      pendingNaturalName: parsed.customerName,
    });

    let msg = `✂️ *${serviceObj.name}*\n`;
    msg += `👤 ${barberObj.name}\n\n`;
    msg += `📅 *Selecciona día*\n\n`;

    days.forEach((d, i) => {
      const label = formatDayLabel(d);
      msg += `${i + 1}. ${label}\n`;
    });

    msg += `\nO escribe una fecha (YYYY-MM-DD)`;

    if (parsed.time) {
      msg += `\n\n_Prefieres a las ${parsed.time}_`;
    }

    return msg;
  }

  const serviceObj = services.find((s) => s.id === selectedService)!;
  const barberObj = barbers.find((b) => b.id === selectedBarber)!;

  return await handleNaturalTimeSelection(
    phone,
    selectedService!,
    selectedBarber!,
    parsed.date!,
    parsed.customerName,
  );
}

async function handleNaturalTimeSelection(
  phone: string,
  serviceId: string,
  barberId: string,
  date: string,
  customerName: string | undefined,
): Promise<string> {
  const services = await getServices();
  const serviceObj = services.find((s) => s.id === serviceId)!;
  const barbers = await getProviders(serviceId);
  const barberObj = barbers.find((b) => b.id === barberId)!;

  const slots = await getAvailableSlots({
    tenantId: DEFAULT_TENANT_ID,
    providerId: barberId,
    date,
    timezone: "America/Mexico_City",
    serviceDurationMinutes: serviceObj.duration_minutes || 30,
    slotStepMinutes: 30,
  });

  const payload: SessionPayload = {
    serviceId,
    serviceName: serviceObj.name,
    serviceDurationMinutes: serviceObj.duration_minutes,
    barberId,
    barberName: barberObj.name,
    date,
    pendingNaturalName: customerName,
  };

  await updateSession(phone, "choose_slot", payload);

  if (!slots.length) {
    return `❌ No hay horarios disponibles el ${formatNaturalDate(date)}.

Escribe:
- "otro día" para ver más opciones
- * para volver al menú`;
  }

  if (slots.length <= 3 && customerName) {
    const quickConfirm = tryQuickConfirm(slots, date, payload, customerName);
    if (quickConfirm) {
      return quickConfirm;
    }
  }

  let msg = `⏰ *Horarios disponibles para ${formatNaturalDate(date)}*\n\n`;

  slots.slice(0, 8).forEach((s, i) => {
    const time = new Date(s.startsAt).toLocaleTimeString("es-MX", {
      hour: "2-digit",
      minute: "2-digit",
    });
    msg += `${i + 1}. ${time}\n`;
  });

  msg += `\nO escribe * para volver al menú`;

  return msg;
}

function tryQuickConfirm(
  slots: { startsAt: string }[],
  date: string,
  payload: SessionPayload,
  customerName?: string,
): string | null {
  if (slots.length === 1) {
    const slot = slots[0];
    const time = new Date(slot.startsAt).toLocaleTimeString("es-MX", {
      hour: "2-digit",
      minute: "2-digit",
    });

    if (!customerName) {
      return null;
    }

    return `⏰ *¿Confirmar a las ${time}?*

Servicio: ${payload.serviceName}
Barbero: ${payload.barberName}
Fecha: ${formatNaturalDate(date)}

Nombre: ${customerName}

1. ✅ Confirmar
2. ❌ Cambiar horario`;
  }
  return null;
}

async function confirmNaturalBooking(
  phone: string,
  serviceId: string,
  barberId: string,
  date: string,
  time: string,
  customerName: string | undefined,
): Promise<string> {
  const services = await getServices();
  const serviceObj = services.find((s) => s.id === serviceId)!;
  const barbers = await getProviders(serviceId);
  const barberObj = barbers.find((b) => b.id === barberId)!;

  const slots = await getAvailableSlots({
    tenantId: DEFAULT_TENANT_ID,
    providerId: barberId,
    date,
    timezone: "America/Mexico_City",
    serviceDurationMinutes: serviceObj.duration_minutes || 30,
    slotStepMinutes: 30,
  });

  const slotMatch = isTimeSlotAvailable(slots, time);

  if (!slotMatch) {
    if (slots.length === 0) {
      return `❌ No hay disponibilidad el ${formatNaturalDate(date)}.

Escribe "otro día" para ver más opciones
o * para volver al menú.`;
    }

    await updateSession(phone, "choose_slot", {
      serviceId,
      serviceName: serviceObj.name,
      serviceDurationMinutes: serviceObj.duration_minutes,
      barberId,
      barberName: barberObj.name,
      date,
      pendingNaturalName: customerName,
    });

    return `❌ No hay disponibilidad a las ${time}.

⏰ *Horarios disponibles el ${formatNaturalDate(date)}:*
${slots
  .slice(0, 5)
  .map(
    (s, i) =>
      `${i + 1}. ${new Date(s.startsAt).toLocaleTimeString("es-MX", { hour: "2-digit", minute: "2-digit" })}`,
  )
  .join("\n")}

Escribe el número o el horario que prefieras,
"otro día" para ver más opciones,
o * para volver al menú.`;
  }

  if (!customerName) {
    await updateSession(phone, "ask_name", {
      serviceId,
      serviceName: serviceObj.name,
      serviceDurationMinutes: serviceObj.duration_minutes,
      barberId,
      barberName: barberObj.name,
      date,
      slotStartsAt: slotMatch.startsAt,
      slotEndsAt: slotMatch.endsAt,
    });

    return `📋 Tu cita está casi lista:

Servicio: ${serviceObj.name}
Barbero: ${barberObj.name}
Fecha: ${formatNaturalDate(date)} a las ${time}

Escribe tu nombre para confirmar:`;
  }

  await updateSession(phone, "confirm", {
    serviceId,
    serviceName: serviceObj.name,
    serviceDurationMinutes: serviceObj.duration_minutes,
    barberId,
    barberName: barberObj.name,
    date,
    slotStartsAt: slotMatch.startsAt,
    slotEndsAt: slotMatch.endsAt,
    customerName: customerName,
  });

  return `📋 *Confirma tu cita*

Servicio: ${serviceObj.name}
Barbero: ${barberObj.name}
Fecha: ${formatNaturalDate(date)} a las ${time}
Nombre: ${customerName}

1. ✅ Confirmar
2. ❌ Cancelar`;
}

async function handleChooseService(
  text: string,
  phone: string,
  payload: SessionPayload & {
    pendingNaturalDate?: string;
    pendingNaturalTime?: string;
    pendingNaturalName?: string;
    pendingNaturalBarberName?: string;
    mode?: string;
  },
) {
  const services = await getServices();

  const numericIndex = parseNumericSelection(text, services.length);
  const index = numericIndex !== null ? numericIndex - 1 : Number(text) - 1;

  if (isNaN(index) || index < 0 || index >= services.length) {
    return "Selecciona un servicio válido.";
  }

  const service = services[index];

  if (payload.mode === "availability") {
    return showServiceAvailability(service, payload.pendingNaturalDate);
  }

  let barberName = payload.pendingNaturalBarberName;

  if (barberName) {
    const barbers = await getProviders(service.id);
    const barberMatch = findBarberByName(barbers, barberName) ?? undefined;
    if (barberMatch) {
      const barber = barbers.find((b) => b.id === barberMatch)!;
      return handleNaturalBookingWithServiceAndBarber(
        phone,
        service,
        barber,
        payload,
      );
    }
  }

  const barbers = await getProviders(service.id);

  if (!barbers.length) {
    return "No hay barberos disponibles para ese servicio.";
  }

  if (barbers.length === 1) {
    return handleNaturalBookingWithServiceAndBarber(
      phone,
      service,
      barbers[0],
      payload,
    );
  }

  await updateSession(phone, "choose_barber", {
    serviceId: service.id,
    serviceName: service.name,
    serviceDurationMinutes: service.duration_minutes,
    pendingNaturalDate: payload.pendingNaturalDate,
    pendingNaturalTime: payload.pendingNaturalTime,
    pendingNaturalName: payload.pendingNaturalName,
  });

  let msg = `✂️ *${service.name}*\n\nSelecciona barbero:\n\n`;

  barbers.forEach((b, i) => {
    msg += `${i + 1}. ${b.name}\n`;
  });

  return msg;
}

async function handleNaturalBookingWithServiceAndBarber(
  phone: string,
  service: { id: string; name: string; duration_minutes: number },
  barber: { id: string; name: string },
  payload: SessionPayload & {
    pendingNaturalDate?: string;
    pendingNaturalTime?: string;
    pendingNaturalName?: string;
  },
): Promise<string> {
  if (payload.pendingNaturalDate) {
    return handleNaturalTimeSelection(
      phone,
      service.id,
      barber.id,
      payload.pendingNaturalDate,
      payload.pendingNaturalName,
    );
  }

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
    pendingNaturalTime: payload.pendingNaturalTime,
    pendingNaturalName: payload.pendingNaturalName,
  });

  let msg = `✂️ *${service.name}*\n`;
  msg += `👤 ${barber.name}\n\n`;
  msg += `📅 *Selecciona día*\n\n`;

  days.forEach((d, i) => {
    const label = formatDayLabel(d);
    msg += `${i + 1}. ${label}\n`;
  });

  msg += `\nO escribe una fecha (YYYY-MM-DD)`;

  if (payload.pendingNaturalTime) {
    msg += `\n\n_Prefieres a las ${payload.pendingNaturalTime}_`;
  }

  return msg;
}

async function handleChooseBarber(
  text: string,
  phone: string,
  payload: SessionPayload,
) {
  const barbers = await getProviders(payload.serviceId!);

  if (hasBarberPreferenceAny(text)) {
    const barber = barbers[0];
    return proceedToDateSelection(phone, payload, barber.id, barber.name);
  }

  const numericIndex = parseNumericSelection(text, barbers.length);
  const index = numericIndex !== null ? numericIndex - 1 : Number(text) - 1;

  if (isNaN(index) || index < 0 || index >= barbers.length) {
    return "Selecciona un barbero válido.";
  }

  const barber = barbers[index];
  return proceedToDateSelection(phone, payload, barber.id, barber.name);
}

async function proceedToDateSelection(
  phone: string,
  payload: SessionPayload,
  barberId: string,
  barberName: string,
): Promise<string> {
  const days = await getNextAvailableDays(
    barberId,
    payload.serviceDurationMinutes || 30,
  );

  if (!days.length) {
    return "No hay disponibilidad en los próximos días.";
  }

  await updateSession(phone, "choose_slot", {
    ...payload,
    barberId,
    barberName,
  });

  let msg = `📅 *Selecciona día*\n\n`;

  days.forEach((d, i) => {
    const label = formatDayLabel(d);
    msg += `${i + 1}. ${label}\n`;
  });

  msg += `\nO escribe una fecha (YYYY-MM-DD)`;

  return msg;
}

async function handleChooseSlot(
  text: string,
  phone: string,
  payload: SessionPayload & { pendingNaturalTime?: string },
) {
  const lower = text.toLowerCase().trim();
  const dateRegex = /^\d{4}-\d{2}-\d{2}$/;

  const OTHER_DAY_PATTERNS = [/^otro\s*d[ií]a$/i, /^ver\s+(?:m[aá]s\s+)?d[ií]as$/i, /^m[aá]s\s+d[ií]as$/i, /^d[ií]as\s+(?:disponibles?|libres?)$/i];
  const wantsAnotherDay = OTHER_DAY_PATTERNS.some(p => p.test(lower)) || lower === "otro";

  if (wantsAnotherDay) {
    const days = await getNextAvailableDays(
      payload.barberId!,
      payload.serviceDurationMinutes || 30,
    );

    if (!days.length) {
      return "No hay más días disponibles. Escribe * para volver al menú.";
    }

    let msg = `📅 *Próximos días disponibles:*\n\n`;

    days.forEach((d, i) => {
      const label = formatDayLabel(d);
      msg += `${i + 1}. ${label}\n`;
    });

    msg += `\nO escribe una fecha (YYYY-MM-DD)\nEscribe * para volver al menú`;

    return msg;
  }

  if (!payload.date) {
    const days = await getNextAvailableDays(
      payload.barberId!,
      payload.serviceDurationMinutes || 30,
    );

    const numericIndex = parseNumericSelection(text, days.length);
    let selectedDate = "";

    if (numericIndex !== null) {
      selectedDate = days[numericIndex - 1] || "";
    } else if (!isNaN(Number(text)) && days[Number(text) - 1]) {
      selectedDate = days[Number(text) - 1];
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

    if (payload.pendingNaturalTime) {
      const slotMatch = isTimeSlotAvailable(slots, payload.pendingNaturalTime);
      if (slotMatch) {
        await updateSession(phone, "ask_name", {
          ...payload,
          date: selectedDate,
          slotStartsAt: slotMatch.startsAt,
          slotEndsAt: slotMatch.endsAt,
        });
        return "Escribe tu nombre:";
      }
    }

    await updateSession(phone, "choose_slot", {
      ...payload,
      date: selectedDate,
    });

    if (slots.length <= 3) {
      const customerName = payload.pendingNaturalName || payload.customerName;
      if (customerName && slots.length === 1) {
        const slot = slots[0];
        const time = new Date(slot.startsAt).toLocaleTimeString("es-MX", {
          hour: "2-digit",
          minute: "2-digit",
        });

        await updateSession(phone, "confirm", {
          ...payload,
          date: selectedDate,
          slotStartsAt: slot.startsAt,
          slotEndsAt: new Date(
            new Date(slot.startsAt).getTime() +
              (payload.serviceDurationMinutes || 30) * 60 * 1000,
          ).toISOString(),
          customerName,
        });

        return `⏰ *¿Confirmar a las ${time}?*

Servicio: ${payload.serviceName}
Barbero: ${payload.barberName}
Fecha: ${formatNaturalDate(selectedDate)}

Nombre: ${customerName}

1. ✅ Confirmar
2. ❌ Cambiar horario`;
      }
    }

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

  if (!slots.length) {
    return "No hay horarios disponibles ese día.";
  }

  let selectedSlot: { startsAt: string; endsAt: string } | null = null;

  const numericIndex = parseNumericSelection(text, slots.length);
  if (numericIndex !== null && slots[numericIndex - 1]) {
    selectedSlot = slots[numericIndex - 1];
  } else if (!isNaN(Number(text)) && slots[Number(text) - 1]) {
    selectedSlot = slots[Number(text) - 1];
  }

  if (!selectedSlot) {
    const partialMatch = matchPartialTimeSlot(text, slots);
    if (partialMatch) {
      selectedSlot = partialMatch;
    }
  }

  if (!selectedSlot) {
    return "Selecciona horario válido.\n\n" + formatSlotsMessage(slots);
  }

  await updateSession(phone, "ask_name", {
    ...payload,
    slotStartsAt: selectedSlot.startsAt,
    slotEndsAt: selectedSlot.endsAt,
  });

  return "Escribe tu nombre:";
}

function formatSlotsMessage(slots: { startsAt: string }[]): string {
  let msg = "⏰ *Horarios disponibles:*\n\n";
  slots.slice(0, 8).forEach((s, i) => {
    const time = new Date(s.startsAt).toLocaleTimeString("es-MX", {
      hour: "2-digit",
      minute: "2-digit",
    });
    msg += `${i + 1}. ${time}\n`;
  });
  return msg;
}

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
1 para confirmar (o "sí", "confirmar", "ok")
2 para cancelar (o "no", "cancelar")`;
}

async function handleConfirm(
  text: string,
  phone: string,
  payload: SessionPayload,
  waPhone: string,
) {
  const isAffirmative = isAffirmativeResponse(text);
  const isNegative = isNegativeResponse(text);

  if (isAffirmative || text === "1") {
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

    const dateFormatted = new Date(payload.slotStartsAt!).toLocaleString("es-MX", {
      weekday: "long",
      day: "numeric",
      month: "long",
      hour: "2-digit",
      minute: "2-digit",
    });

    return `✅ *¡Cita confirmada!*

📅 ${dateFormatted}
✂️ ${payload.serviceName}
👤 con ${payload.barberName}
👤 Cliente: ${payload.customerName}

¡Te esperamos! 💈`;
  }

  if (isNegative || text === "2") {
    await updateSession(phone, "menu", {});
    return "❌ Cita cancelada.\n\nCuando quieras agendar de nuevo, escribe * para comenzar.";
  }

  return `📋 *Confirma tu cita*

Servicio: ${payload.serviceName}
Barbero: ${payload.barberName}
Fecha: ${formatNaturalDate(payload.date!)} a las ${new Date(payload.slotStartsAt!).toLocaleTimeString("es-MX", { hour: "2-digit", minute: "2-digit" })}
Nombre: ${payload.customerName}

Responde:
1 para confirmar
2 para cancelar
O escribe * para volver al menú`;
}

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

async function handleAvailabilityQuery(
  phone: string,
  preferredDate?: string,
): Promise<string> {
  const services = await getServices();

  if (!services.length) {
    return "No hay servicios disponibles en este momento.";
  }

  if (services.length === 1) {
    return showServiceAvailability(services[0], preferredDate);
  }

  await updateSession(phone, "choose_service", {
    mode: "availability",
    pendingNaturalDate: preferredDate,
  });

  let msg = "📅 *Ver disponibilidad*\n\nSelecciona servicio:\n\n";

  services.forEach((s, i) => {
    const price = s.price_cents ? `$${(s.price_cents / 100).toFixed(0)}` : "";
    msg += `${i + 1}. ${s.name} (${s.duration_minutes}min) ${price}\n`;
  });

  return msg;
}

async function showServiceAvailability(
  service: { id: string; name: string; duration_minutes: number },
  preferredDate?: string,
): Promise<string> {
  const barbers = await getProviders(service.id);

  if (!barbers.length) {
    return `No hay barberos disponibles para ${service.name}.`;
  }

  if (barbers.length === 1) {
    return showBarberAvailability(service, barbers[0], preferredDate);
  }

  let msg = `✂️ *${service.name}*\n\nSelecciona barbero para ver disponibilidad:\n\n`;

  barbers.forEach((b, i) => {
    msg += `${i + 1}. ${b.name}\n`;
  });

  msg += "\nO escribe * para volver al menú";

  return msg;
}

async function showBarberAvailability(
  service: { id: string; name: string; duration_minutes: number },
  barber: { id: string; name: string },
  preferredDate?: string,
): Promise<string> {
  const days = await getNextAvailableDays(
    barber.id,
    service.duration_minutes || 30,
  );

  if (!days.length) {
    return `😔 No hay disponibilidad para ${service.name} con ${barber.name} en los próximos días.`;
  }

  let msg = `⏰ *Disponibilidad*\n`;
  msg += `Servicio: ${service.name}\n`;
  msg += `Barbero: ${barber.name}\n\n`;

  if (preferredDate && days.includes(preferredDate)) {
    const slots = await getAvailableSlots({
      tenantId: DEFAULT_TENANT_ID,
      providerId: barber.id,
      date: preferredDate,
      timezone: "America/Mexico_City",
      serviceDurationMinutes: service.duration_minutes || 30,
      slotStepMinutes: 30,
    });

    if (slots.length) {
      msg += `📅 *${formatNaturalDate(preferredDate)}*\n\n`;
      slots.slice(0, 10).forEach((s, i) => {
        const time = new Date(s.startsAt).toLocaleTimeString("es-MX", {
          hour: "2-digit",
          minute: "2-digit",
        });
        msg += `${i + 1}. ${time}\n`;
      });
      msg += `\nEscribe * para volver al menú\no "agendar" para reservar`;
      return msg;
    }
  }

  msg += "📅 *Próximos días disponibles:*\n\n";

  days.slice(0, 5).forEach((d, i) => {
    const label = formatDayLabel(d);
    msg += `${i + 1}. ${label}\n`;
  });

  msg += `\nEscribe * para volver al menú\no "agendar" para reservar`;
  return msg;
}

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

function formatNaturalDate(dateStr: string): string {
  const d = new Date(dateStr + "T00:00:00");
  const weekdays = [
    "domingo",
    "lunes",
    "martes",
    "miércoles",
    "jueves",
    "viernes",
    "sábado",
  ];
  const months = [
    "enero",
    "febrero",
    "marzo",
    "abril",
    "mayo",
    "junio",
    "julio",
    "agosto",
    "septiembre",
    "octubre",
    "noviembre",
    "diciembre",
  ];

  const weekday = weekdays[d.getDay()];
  const day = d.getDate();
  const month = months[d.getMonth()];

  return `${weekday} ${day} de ${month}`;
}
