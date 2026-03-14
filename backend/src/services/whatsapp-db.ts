import { pool } from "../db/pool.js";
import { getAvailableSlots } from "./booking.js";

export const DEFAULT_TENANT_ID = "fb8c1836-8ca6-4d41-9edd-8e5d5cffdb14";

export type SessionPayload = {
  serviceId?: string;
  serviceName?: string;

  barberId?: string;
  barberName?: string;

  serviceDurationMinutes?: number;

  date?: string;

  slotStartsAt?: string;
  slotEndsAt?: string;

  customerName?: string;
};

let tenantName = "";

export async function getTenantName(): Promise<string> {
  if (tenantName) return tenantName;
  const res = await pool.query("SELECT name FROM tenants WHERE id = $1", [
    DEFAULT_TENANT_ID,
  ]);
  tenantName = res.rows[0]?.name || "La Barbería";
  return tenantName;
}

export async function getServices() {
  const res = await pool.query(
    `SELECT id,name,duration_minutes,price_cents
     FROM services
     WHERE tenant_id=$1 AND is_active=true`,
    [DEFAULT_TENANT_ID],
  );

  return res.rows;
}

export async function getProviders(serviceId: string) {
  const res = await pool.query(
    `
  SELECT p.id,p.name
  FROM providers p
  JOIN provider_services ps ON ps.provider_id = p.id
  WHERE ps.service_id=$1 AND p.is_active=true
  `,
    [serviceId],
  );

  return res.rows;
}

export async function getOrCreateSession(phone: string) {
  const res = await pool.query(
    `
  INSERT INTO conversation_sessions (tenant_id,wa_phone_e164)
  VALUES ($1,$2)
  ON CONFLICT (tenant_id,wa_phone_e164)
  DO UPDATE SET updated_at=NOW()
  RETURNING state,payload
  `,
    [DEFAULT_TENANT_ID, phone],
  );

  return res.rows[0];
}

export async function updateSession(
  phone: string,
  state: string,
  payload: SessionPayload,
) {
  await pool.query(
    `
  UPDATE conversation_sessions
  SET state=$1,payload=$2
  WHERE tenant_id=$3 AND wa_phone_e164=$4
  `,
    [state, payload, DEFAULT_TENANT_ID, phone],
  );
}

export async function getNextAvailableDays(
  providerId: string,
  serviceDurationMinutes: number,
) {
  const days: string[] = [];

  for (let i = 0; i < 14 && days.length < 7; i++) {
    const d = new Date();
    d.setDate(d.getDate() + i);

    const date = d.toISOString().slice(0, 10);

    const slots = await getAvailableSlots({
      tenantId: DEFAULT_TENANT_ID,
      providerId,
      date,
      timezone: "America/Mexico_City",
      serviceDurationMinutes,
      slotStepMinutes: 30,
    });

    if (slots.length) {
      days.push(date);
    }
  }

  return days;
}

export async function getAppointmentsByPhone(phone: string) {
  const waPhone = `+${phone}`;

  const result = await pool.query(
    `
SELECT 
a.starts_at,
s.name AS service,
p.name AS provider
FROM appointments a
JOIN services s ON s.id = a.service_id
JOIN providers p ON p.id = a.provider_id
JOIN customers c ON c.id = a.customer_id
WHERE c.wa_phone_e164 = $1
ORDER BY a.starts_at
LIMIT 5
`,
    [waPhone],
  );

  return result.rows;
}
