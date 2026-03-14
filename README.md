# mi-turno

Stack Dockerizado para:
- Backend en TypeScript (ideal para Baileys)
- Frontend con Next.js
- Base de datos PostgreSQL
- Gestor de paquetes: pnpm

## Requisitos

- Docker y Docker Compose instalados
- Puerto `3001` y `5432` disponibles
- (Opcional) `curl` para pruebas rapidas de API

## Estructura esperada

- `backend/` con API Express TypeScript
- `frontend/` con su `package.json`

## Uso

1. Copia variables de entorno:

```bash
cp .env.example .env
```

2. Levanta los servicios:

```bash
docker compose up -d --build
```

Servicios:
- Backend: `http://localhost:3001`
- PostgreSQL: `localhost:5432`

Nota: el servicio de `frontend` esta comentado en `docker-compose.yml`, por eso no se levanta por defecto.

## Base de datos (MVP citas)

Migraciones en:

- `backend/db/migrations/`

Aplicar todas las migraciones dentro del contenedor de Postgres:

```bash
for file in backend/db/migrations/*.sql; do docker compose exec -T postgres psql -U ${POSTGRES_USER:-mi_turno_user} -d ${POSTGRES_DB:-mi_turno} -f /dev/stdin < "$file"; done
```

Importante: estas migraciones no son idempotentes. Si ya corriste una vez, no las vuelvas a ejecutar sobre la misma base.

Seed demo (tenant/provider/service/working hours):

```bash
docker compose exec -T postgres psql -U ${POSTGRES_USER:-mi_turno_user} -d ${POSTGRES_DB:-mi_turno} -f /dev/stdin < backend/db/seeds/001_demo.sql
```

Para obtener los IDs demo cargados:

```bash
docker compose exec -T postgres psql -U ${POSTGRES_USER:-mi_turno_user} -d ${POSTGRES_DB:-mi_turno} -c "SELECT t.id AS tenant_id, p.id AS provider_id, s.id AS service_id FROM tenants t JOIN providers p ON p.tenant_id = t.id JOIN services s ON s.tenant_id = t.id LIMIT 1;"
```

## Endpoints backend base

- `GET /health`
- `GET /db/ping`
- `GET /availability?tenantId=...&providerId=...&date=YYYY-MM-DD&timezone=America/Mexico_City&durationMinutes=30&slotStepMinutes=30`
- `POST /appointments`
- `POST /appointments/:appointmentId/cancel`
- `GET /baileys/status`
- `POST /baileys/connect`
- `GET /baileys/qr?format=svg|terminal|raw`

Ejemplo rapido de prueba:

```bash
curl "http://localhost:3001/availability?tenantId=<TENANT_ID>&providerId=<PROVIDER_ID>&date=2026-03-11&timezone=America/Mexico_City&durationMinutes=30"
```

```bash
curl -X POST "http://localhost:3001/appointments" \
  -H "Content-Type: application/json" \
  -d '{
    "tenantId": "<TENANT_ID>",
    "providerId": "<PROVIDER_ID>",
    "serviceId": "<SERVICE_ID>",
    "startsAt": "2026-03-11T16:00:00.000Z",
    "durationMinutes": 30,
    "customerPhoneE164": "+525511111111",
    "customerName": "Cliente Demo"
  }'
```

## WhatsApp (Baileys)

1. Iniciar conexion:

```bash
curl -X POST "http://localhost:3001/baileys/connect"
```

2. Pedir QR en terminal:

```bash
curl "http://localhost:3001/baileys/qr?format=terminal"
```

3. Ver estado:

```bash
curl "http://localhost:3001/baileys/status"
```

Si tenes error `401` de Baileys por credenciales viejas, limpia el volumen de auth:

```bash
docker compose down
docker volume rm mi-turno_baileys_auth
docker compose up -d
```

## Recordatorios automáticos

Cuando se crea una cita por `POST /appointments`, el backend agenda un `reminder_job` para enviarlo por WhatsApp `REMINDER_LEAD_MINUTES` antes del `starts_at`.

- Si la cita se cancela con `POST /appointments/:appointmentId/cancel`, se eliminan los recordatorios pendientes.
- El worker corre dentro del backend y procesa jobs pendientes cada `REMINDER_POLL_INTERVAL_MS`.
- Reintenta hasta `REMINDER_MAX_ATTEMPTS` veces si falla el envío.

Variables de entorno relevantes:

- `REMINDER_WORKER_ENABLED` (default `true`)
- `REMINDER_LEAD_MINUTES` (default `120`)
- `REMINDER_POLL_INTERVAL_MS` (default `15000`)
- `REMINDER_BATCH_SIZE` (default `20`)
- `REMINDER_MAX_ATTEMPTS` (default `3`)

## Reset completo (entorno nuevo)

Si queres reiniciar desde cero en otra compu o limpiar todo:

```bash
docker compose down
docker volume rm mi-turno_postgres_data mi-turno_baileys_auth
docker compose up -d --build
```
