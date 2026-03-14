import "dotenv/config";

function toNumber(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function toBoolean(value: string | undefined, fallback: boolean): boolean {
  if (!value) return fallback;
  return value === "true";
}

export const env = {
  nodeEnv: process.env.NODE_ENV ?? "development",
  port: toNumber(process.env.PORT, 3001),
  databaseUrl:
    process.env.DATABASE_URL ??
    "postgresql://mi_turno_user:mi_turno_pass@localhost:5432/mi_turno",
  baileysAuthDir: process.env.BAILEYS_AUTH_DIR ?? "auth_info_baileys",
  baileysAutoConnect: process.env.BAILEYS_AUTO_CONNECT === "true",
  reminderWorkerEnabled: toBoolean(process.env.REMINDER_WORKER_ENABLED, true),
  reminderLeadMinutes: toNumber(process.env.REMINDER_LEAD_MINUTES, 120),
  reminderPollIntervalMs: toNumber(process.env.REMINDER_POLL_INTERVAL_MS, 15_000),
  reminderBatchSize: toNumber(process.env.REMINDER_BATCH_SIZE, 20),
  reminderMaxAttempts: toNumber(process.env.REMINDER_MAX_ATTEMPTS, 3),
};
