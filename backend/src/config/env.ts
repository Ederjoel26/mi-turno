import "dotenv/config";

function toNumber(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export const env = {
  nodeEnv: process.env.NODE_ENV ?? "development",
  port: toNumber(process.env.PORT, 3001),
  databaseUrl:
    process.env.DATABASE_URL ??
    "postgresql://mi_turno_user:mi_turno_pass@localhost:5432/mi_turno",
  baileysAuthDir: process.env.BAILEYS_AUTH_DIR ?? "auth_info_baileys",
  baileysAutoConnect: process.env.BAILEYS_AUTO_CONNECT === "true"
};
