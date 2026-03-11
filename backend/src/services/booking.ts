import { PoolClient } from "pg";
import { pool } from "../db/pool.js";

const ACTIVE_APPOINTMENT_STATUSES = ["pending", "confirmed"] as const;

type TimeRange = {
  start: Date;
  end: Date;
};

type DbTimeRangeRow = {
  starts_at: Date;
  ends_at: Date;
};

export type AvailableSlot = {
  startsAt: string;
  endsAt: string;
};

export type GetAvailableSlotsInput = {
  tenantId: string;
  providerId: string;
  date: string;
  timezone: string;
  serviceDurationMinutes: number;
  slotStepMinutes?: number;
};

export type CreateAppointmentInput = {
  tenantId: string;
  providerId: string;
  serviceId: string | null;
  startsAt: string;
  durationMinutes: number;
  customerPhoneE164: string;
  customerName: string;
  notes?: string;
  createdBy?: "bot" | "manual";
};

export type CreatedAppointment = {
  id: string;
  startsAt: string;
  endsAt: string;
  status: string;
};

export type CancelledAppointment = {
  id: string;
  status: string;
  updatedAt: string;
};

export class SlotConflictError extends Error {
  constructor(message = "Selected slot is no longer available") {
    super(message);
    this.name = "SlotConflictError";
  }
}

export class DomainValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DomainValidationError";
  }
}

export class AppointmentNotFoundError extends Error {
  constructor(message = "Appointment not found") {
    super(message);
    this.name = "AppointmentNotFoundError";
  }
}

export async function getAvailableSlots(
  input: GetAvailableSlotsInput,
): Promise<AvailableSlot[]> {
  validateDuration(input.serviceDurationMinutes, "serviceDurationMinutes");

  const slotStepMinutes = input.slotStepMinutes ?? input.serviceDurationMinutes;
  validateDuration(slotStepMinutes, "slotStepMinutes");

  await ensureProviderBelongsToTenant(input.tenantId, input.providerId);

  const weekday = getWeekdayFromLocalDate(input.date);
  const workingRanges = await getWorkingRangesUtc(
    input.providerId,
    input.date,
    input.timezone,
    weekday,
  );

  if (workingRanges.length === 0) return [];

  const windowStart = workingRanges[0].start;
  const windowEnd = workingRanges[workingRanges.length - 1].end;

  const busyRanges = await getBusyRanges(
    input.tenantId,
    input.providerId,
    windowStart,
    windowEnd,
  );

  const freeRanges = subtractRanges(workingRanges, busyRanges);

  return buildSlots(
    freeRanges,
    input.serviceDurationMinutes,
    slotStepMinutes,
  ).map((slot) => ({
    startsAt: slot.start.toISOString(),
    endsAt: slot.end.toISOString(),
  }));
}

export async function createAppointmentAtomic(
  input: CreateAppointmentInput,
): Promise<CreatedAppointment> {
  validateDuration(input.durationMinutes, "durationMinutes");

  const startsAt = new Date(input.startsAt);

  if (Number.isNaN(startsAt.getTime())) {
    throw new DomainValidationError("Invalid startsAt timestamp");
  }

  const endsAt = addMinutes(startsAt, input.durationMinutes);

  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    await ensureProviderBelongsToTenant(
      input.tenantId,
      input.providerId,
      client,
    );

    if (input.serviceId) {
      await ensureServiceBelongsToTenant(
        input.tenantId,
        input.serviceId,
        client,
      );
    }

    const upsertCustomer = await client.query<{ id: string }>(
      `
        INSERT INTO customers (tenant_id, wa_phone_e164, name)
        VALUES ($1, $2, $3)
        ON CONFLICT (tenant_id, wa_phone_e164)
        DO UPDATE SET
          name = EXCLUDED.name,
          updated_at = NOW()
        RETURNING id
      `,
      [input.tenantId, input.customerPhoneE164, input.customerName],
    );

    const customerId = upsertCustomer.rows[0]?.id;

    if (!customerId) {
      throw new Error("Unable to create or fetch customer");
    }

    const insertAppointment = await client.query<{
      id: string;
      starts_at: Date;
      ends_at: Date;
      status: string;
    }>(
      `
        INSERT INTO appointments (
          tenant_id,
          provider_id,
          customer_id,
          service_id,
          starts_at,
          ends_at,
          status,
          notes,
          created_by
        ) VALUES ($1, $2, $3, $4, $5, $6, 'confirmed', $7, $8)
        RETURNING id, starts_at, ends_at, status
      `,
      [
        input.tenantId,
        input.providerId,
        customerId,
        input.serviceId,
        startsAt,
        endsAt,
        input.notes ?? null,
        input.createdBy ?? "bot",
      ],
    );

    await client.query("COMMIT");

    const created = insertAppointment.rows[0];

    if (!created) {
      throw new Error("Unable to create appointment");
    }

    return {
      id: created.id,
      startsAt: created.starts_at.toISOString(),
      endsAt: created.ends_at.toISOString(),
      status: created.status,
    };
  } catch (error) {
    await client.query("ROLLBACK");

    if (isPgExclusionViolation(error)) {
      throw new SlotConflictError();
    }

    throw error;
  } finally {
    client.release();
  }
}

export async function cancelAppointment(
  tenantId: string,
  appointmentId: string,
  reason?: string,
): Promise<CancelledAppointment> {
  const result = await pool.query<{
    id: string;
    status: string;
    updated_at: Date;
  }>(
    `
      UPDATE appointments
      SET
        status = 'cancelled',
        notes = CASE
          WHEN $3::text IS NULL THEN notes
          WHEN notes IS NULL OR notes = '' THEN $3
          ELSE notes || E'\n' || $3
        END,
        updated_at = NOW()
      WHERE id = $1
        AND tenant_id = $2
        AND status IN ('pending', 'confirmed')
      RETURNING id, status, updated_at
    `,
    [appointmentId, tenantId, reason ?? null],
  );

  const cancelled = result.rows[0];

  if (!cancelled) {
    throw new AppointmentNotFoundError();
  }

  return {
    id: cancelled.id,
    status: cancelled.status,
    updatedAt: cancelled.updated_at.toISOString(),
  };
}

function validateDuration(value: number, fieldName: string): void {
  if (!Number.isInteger(value) || value <= 0) {
    throw new DomainValidationError(`${fieldName} must be a positive integer`);
  }
}

function getWeekdayFromLocalDate(date: string): number {
  const parsed = new Date(`${date}T12:00:00.000Z`);

  if (Number.isNaN(parsed.getTime())) {
    throw new DomainValidationError("Invalid date format, expected YYYY-MM-DD");
  }

  return parsed.getUTCDay();
}

async function ensureProviderBelongsToTenant(
  tenantId: string,
  providerId: string,
  client: PoolClient | null = null,
): Promise<void> {
  const db = client ?? pool;

  const result = await db.query<{ id: string }>(
    `
      SELECT id
      FROM providers
      WHERE id = $1 AND tenant_id = $2 AND is_active = TRUE
      LIMIT 1
    `,
    [providerId, tenantId],
  );

  if (result.rowCount === 0) {
    throw new DomainValidationError("Provider not found for this tenant");
  }
}

async function ensureServiceBelongsToTenant(
  tenantId: string,
  serviceId: string,
  client: PoolClient | null = null,
): Promise<void> {
  const db = client ?? pool;

  const result = await db.query<{ id: string }>(
    `
      SELECT id
      FROM services
      WHERE id = $1 AND tenant_id = $2 AND is_active = TRUE
      LIMIT 1
    `,
    [serviceId, tenantId],
  );

  if (result.rowCount === 0) {
    throw new DomainValidationError("Service not found for this tenant");
  }
}

async function getWorkingRangesUtc(
  providerId: string,
  date: string,
  timezone: string,
  weekday: number,
): Promise<TimeRange[]> {
  const result = await pool.query<DbTimeRangeRow>(
    `
      SELECT
        (($2::date + start_time)::timestamp AT TIME ZONE $3) AS starts_at,
        (($2::date + end_time)::timestamp AT TIME ZONE $3) AS ends_at
      FROM working_hours
      WHERE provider_id = $1
        AND weekday = $4
      ORDER BY start_time
    `,
    [providerId, date, timezone, weekday],
  );

  return result.rows.map((row) => ({
    start: new Date(row.starts_at),
    end: new Date(row.ends_at),
  }));
}

async function getBusyRanges(
  tenantId: string,
  providerId: string,
  windowStart: Date,
  windowEnd: Date,
): Promise<TimeRange[]> {
  const appointments = await pool.query<DbTimeRangeRow>(
    `
      SELECT starts_at, ends_at
      FROM appointments
      WHERE tenant_id = $1
        AND provider_id = $2
        AND status = ANY($3::appointment_status[])
        AND tstzrange(starts_at, ends_at, '[)') && tstzrange($4::timestamptz, $5::timestamptz, '[)')
    `,
    [
      tenantId,
      providerId,
      ACTIVE_APPOINTMENT_STATUSES,
      windowStart.toISOString(),
      windowEnd.toISOString(),
    ],
  );

  const timeOff = await pool.query<DbTimeRangeRow>(
    `
      SELECT starts_at, ends_at
      FROM time_off
      WHERE provider_id = $1
        AND tstzrange(starts_at, ends_at, '[)') && tstzrange($2::timestamptz, $3::timestamptz, '[)')
    `,
    [providerId, windowStart.toISOString(), windowEnd.toISOString()],
  );

  return [...appointments.rows, ...timeOff.rows]
    .map((row) => ({
      start: new Date(row.starts_at),
      end: new Date(row.ends_at),
    }))
    .sort((a, b) => a.start.getTime() - b.start.getTime());
}

function subtractRanges(
  baseRanges: TimeRange[],
  busyRanges: TimeRange[],
): TimeRange[] {
  if (busyRanges.length === 0) return baseRanges;

  const mergedBusy = mergeRanges(busyRanges);
  const result: TimeRange[] = [];

  for (const base of baseRanges) {
    let cursor = base.start;

    for (const busy of mergedBusy) {
      if (busy.end <= base.start || busy.start >= base.end) continue;

      if (busy.start > cursor) {
        result.push({ start: cursor, end: busy.start });
      }

      if (busy.end > cursor) {
        cursor = busy.end;
      }

      if (cursor >= base.end) break;
    }

    if (cursor < base.end) {
      result.push({ start: cursor, end: base.end });
    }
  }

  return result.filter((range) => range.end > range.start);
}

function mergeRanges(ranges: TimeRange[]): TimeRange[] {
  if (ranges.length <= 1) return ranges;

  const sorted = [...ranges].sort(
    (a, b) => a.start.getTime() - b.start.getTime(),
  );
  const merged: TimeRange[] = [sorted[0]];

  for (let i = 1; i < sorted.length; i += 1) {
    const current = sorted[i];
    const last = merged[merged.length - 1];

    if (current.start <= last.end) {
      if (current.end > last.end) {
        last.end = current.end;
      }
      continue;
    }

    merged.push({ start: current.start, end: current.end });
  }

  return merged;
}

function buildSlots(
  freeRanges: TimeRange[],
  durationMinutes: number,
  stepMinutes: number,
): TimeRange[] {
  const durationMs = durationMinutes * 60_000;
  const stepMs = stepMinutes * 60_000;
  const slots: TimeRange[] = [];

  for (const range of freeRanges) {
    let startMs = range.start.getTime();
    const endMs = range.end.getTime();

    while (startMs + durationMs <= endMs) {
      const slotStart = new Date(startMs);
      const slotEnd = new Date(startMs + durationMs);

      slots.push({ start: slotStart, end: slotEnd });
      startMs += stepMs;
    }
  }

  return slots;
}

function addMinutes(date: Date, minutes: number): Date {
  return new Date(date.getTime() + minutes * 60_000);
}

function isPgExclusionViolation(error: unknown): boolean {
  return (error as { code?: string } | null)?.code === "23P01";
}
