BEGIN;

ALTER TABLE barbers RENAME TO providers;
ALTER TABLE barber_services RENAME TO provider_services;

ALTER TABLE working_hours RENAME COLUMN barber_id TO provider_id;
ALTER TABLE time_off RENAME COLUMN barber_id TO provider_id;
ALTER TABLE appointments RENAME COLUMN barber_id TO provider_id;
ALTER TABLE provider_services RENAME COLUMN barber_id TO provider_id;

ALTER INDEX IF EXISTS idx_barbers_tenant_id RENAME TO idx_providers_tenant_id;
ALTER INDEX IF EXISTS idx_time_off_barber_id RENAME TO idx_time_off_provider_id;
ALTER INDEX IF EXISTS idx_appointments_barber_start RENAME TO idx_appointments_provider_start;

ALTER TABLE appointments RENAME CONSTRAINT appointments_no_overlap TO appointments_no_overlap_provider;

COMMIT;
