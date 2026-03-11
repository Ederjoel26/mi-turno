BEGIN;

WITH inserted_tenant AS (
  INSERT INTO tenants (name, timezone, phone_e164, trial_ends_at)
  SELECT
    'Demo Barberia',
    'America/Mexico_City',
    '+525500000001',
    NOW() + INTERVAL '14 days'
  WHERE NOT EXISTS (
    SELECT 1
    FROM tenants
    WHERE name = 'Demo Barberia' AND phone_e164 = '+525500000001'
  )
  RETURNING id
), tenant_row AS (
  SELECT id FROM inserted_tenant
  UNION ALL
  SELECT id
  FROM tenants
  WHERE name = 'Demo Barberia' AND phone_e164 = '+525500000001'
  ORDER BY id
  LIMIT 1
), upsert_provider AS (
  INSERT INTO providers (tenant_id, name, phone_e164)
  SELECT id, 'Alex', '+525500000010'
  FROM tenant_row
  ON CONFLICT (tenant_id, name)
  DO UPDATE SET phone_e164 = EXCLUDED.phone_e164, updated_at = NOW()
  RETURNING id, tenant_id
), provider_row AS (
  SELECT id, tenant_id FROM upsert_provider
  UNION ALL
  SELECT p.id, p.tenant_id
  FROM providers p
  JOIN tenant_row t ON t.id = p.tenant_id
  WHERE p.name = 'Alex'
  ORDER BY id
  LIMIT 1
), upsert_service AS (
  INSERT INTO services (tenant_id, name, duration_minutes, price_cents)
  SELECT id, 'Corte Clasico', 30, 15000
  FROM tenant_row
  ON CONFLICT (tenant_id, name)
  DO UPDATE SET
    duration_minutes = EXCLUDED.duration_minutes,
    price_cents = EXCLUDED.price_cents,
    updated_at = NOW()
  RETURNING id, tenant_id
), service_row AS (
  SELECT id, tenant_id FROM upsert_service
  UNION ALL
  SELECT s.id, s.tenant_id
  FROM services s
  JOIN tenant_row t ON t.id = s.tenant_id
  WHERE s.name = 'Corte Clasico'
  ORDER BY id
  LIMIT 1
)
INSERT INTO provider_services (provider_id, service_id)
SELECT p.id, s.id
FROM provider_row p
JOIN service_row s ON s.tenant_id = p.tenant_id
ON CONFLICT (provider_id, service_id) DO NOTHING;

INSERT INTO working_hours (provider_id, weekday, start_time, end_time)
SELECT p.id, weekday, '10:00'::time, '18:00'::time
FROM providers p
JOIN tenants t ON t.id = p.tenant_id
CROSS JOIN (VALUES (1), (2), (3), (4), (5), (6)) AS days(weekday)
WHERE t.name = 'Demo Barberia'
  AND t.phone_e164 = '+525500000001'
  AND p.name = 'Alex'
ON CONFLICT (provider_id, weekday, start_time, end_time) DO NOTHING;

COMMIT;

SELECT
  t.id AS tenant_id,
  p.id AS provider_id,
  s.id AS service_id,
  s.duration_minutes
FROM tenants t
JOIN providers p ON p.tenant_id = t.id AND p.name = 'Alex'
JOIN services s ON s.tenant_id = t.id AND s.name = 'Corte Clasico'
WHERE t.name = 'Demo Barberia' AND t.phone_e164 = '+525500000001'
LIMIT 1;
