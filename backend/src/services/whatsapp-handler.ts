import type { WASocket } from "@whiskeysockets/baileys";
import { pool } from "../db/pool.js";

// Este es el tenant q tengas en tu bd de pruebas (lo deje estatico para pruebas)
const DEFAULT_TENANT_ID = "fb8c1836-8ca6-4d41-9edd-8e5d5cffdb14";

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
  // Pa guardarlo en la db
  const phone = jid.split("@")[0];

  const session = await getOrCreateSession(phone);

  let response = "";

  // Todos los casos que pueden pasar (solo prueba)
  switch (session.state) {
    case "init":
      await updateSession(phone, "menu", {});
      response = `¡Hola! 👋\nBienvenido a *La Barberia Perrona*\n\n¿Qué deseas hacer?\n1. 📅 Agendar cita\n2. 📋 Mis citas`;
      break;

    case "menu":
      if (text === "1") {
        // Agendar cita
        await updateSession(phone, "choose_service", {});
        response = "No, maniana.";
      } else {
        // por si no le sabe y pone otra el wey
        response = "Selecciona una opción válida (1 o 2).";
      }
      break;

    case "choose_service":
      // Ya cuando selecciono algo
      response = `Corte guardado pe, nos vemos pronto`;
      await updateSession(phone, "init", {}); // Nomas se reinicia para seguir haciendo pruebas
      break;

    default:
      response = "Escribe algo para empezar.";
      await updateSession(phone, "init", {});
  }

  await sock.sendMessage(jid, { text: response });
}

// Obtener el estado de la sesión actual
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

// Ir actualizando la session actual para que no quede siempre en init
async function updateSession(phone: string, state: string, payload: any) {
  await pool.query(
    `UPDATE conversation_sessions SET state = $1, payload = $2 
     WHERE wa_phone_e164 = $3 AND tenant_id = $4`,
    [state, JSON.stringify(payload), phone, DEFAULT_TENANT_ID],
  );
}
