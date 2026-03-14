import { env } from "../config/env.js";
import { pool } from "../db/pool.js";
import { sendWhatsAppText } from "./baileys.js";

type DueReminderJobRow = {
  id: string;
  attempt_count: number;
  customer_phone_e164: string;
  customer_name: string | null;
  provider_name: string;
  service_name: string | null;
  appointment_starts_at: Date;
  tenant_timezone: string;
};

let workerInterval: NodeJS.Timeout | null = null;
let inFlight: Promise<void> | null = null;

function formatAppointmentTime(startsAt: Date, timezone: string): string {
  return new Intl.DateTimeFormat("es-MX", {
    timeZone: timezone,
    weekday: "short",
    day: "2-digit",
    month: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(startsAt);
}

function buildReminderMessage(job: DueReminderJobRow): string {
  const customerName = job.customer_name?.trim() || "hola";
  const appointmentTime = formatAppointmentTime(
    job.appointment_starts_at,
    job.tenant_timezone,
  );
  const serviceText = job.service_name ? ` para ${job.service_name}` : "";

  return `Hola ${customerName}, te recordamos tu cita${serviceText} con ${job.provider_name} el ${appointmentTime}. Si no puedes asistir, avisanos por este medio.`;
}

async function processReminderBatch(): Promise<void> {
  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    const dueJobs = await client.query<DueReminderJobRow>(
      `
        SELECT
          rj.id,
          rj.attempt_count,
          c.wa_phone_e164 AS customer_phone_e164,
          c.name AS customer_name,
          p.name AS provider_name,
          s.name AS service_name,
          a.starts_at AS appointment_starts_at,
          t.timezone AS tenant_timezone
        FROM reminder_jobs rj
        JOIN appointments a ON a.id = rj.appointment_id
        JOIN tenants t ON t.id = a.tenant_id
        JOIN customers c ON c.id = a.customer_id
        JOIN providers p ON p.id = a.provider_id
        LEFT JOIN services s ON s.id = a.service_id
        WHERE rj.sent_at IS NULL
          AND rj.failed_at IS NULL
          AND rj.send_at <= NOW()
          AND rj.attempt_count < $1
          AND a.status IN ('pending', 'confirmed')
        ORDER BY rj.send_at
        FOR UPDATE OF rj SKIP LOCKED
        LIMIT $2
      `,
      [env.reminderMaxAttempts, env.reminderBatchSize],
    );

    for (const job of dueJobs.rows) {
      const nextAttemptCount = job.attempt_count + 1;

      try {
        await sendWhatsAppText(
          job.customer_phone_e164,
          buildReminderMessage(job),
        );

        await client.query(
          `
            UPDATE reminder_jobs
            SET sent_at = NOW(),
                failed_at = NULL,
                attempt_count = $2
            WHERE id = $1
          `,
          [job.id, nextAttemptCount],
        );
      } catch (error) {
        const exhaustedAttempts = nextAttemptCount >= env.reminderMaxAttempts;

        await client.query(
          `
            UPDATE reminder_jobs
            SET attempt_count = $2,
                failed_at = CASE WHEN $3::boolean THEN NOW() ELSE NULL END
            WHERE id = $1
          `,
          [job.id, nextAttemptCount, exhaustedAttempts],
        );

        console.error("Reminder delivery failed:", {
          reminderJobId: job.id,
          attempts: nextAttemptCount,
          exhaustedAttempts,
          error: (error as Error).message,
        });
      }
    }

    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    console.error("Reminder worker batch failed:", error);
  } finally {
    client.release();
  }
}

async function runTick(): Promise<void> {
  if (inFlight) return;

  inFlight = processReminderBatch().finally(() => {
    inFlight = null;
  });

  await inFlight;
}

export function startReminderWorker(): void {
  if (workerInterval) return;

  workerInterval = setInterval(() => {
    void runTick();
  }, env.reminderPollIntervalMs);

  workerInterval.unref?.();
  void runTick();

  console.log(
    `Reminder worker started (poll=${env.reminderPollIntervalMs}ms, batch=${env.reminderBatchSize}, lead=${env.reminderLeadMinutes}m)`,
  );
}

export async function stopReminderWorker(): Promise<void> {
  if (workerInterval) {
    clearInterval(workerInterval);
    workerInterval = null;
  }

  if (inFlight) {
    await inFlight;
  }
}
