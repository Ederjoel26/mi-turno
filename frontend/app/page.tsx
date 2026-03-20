"use client";

import { FormEvent, useEffect, useMemo, useState } from "react";

type BaileysStatus = {
  connected: boolean;
  connecting: boolean;
  lastQr: string | null;
  lastPairingCode: string | null;
  lastDisconnectReason: string | null;
};

type ServiceItem = {
  name: string;
  durationMinutes: number;
  price: number;
};

type DayConfig = {
  day: string;
  enabled: boolean;
  start: string;
  end: string;
  breakStart: string;
  breakEnd: string;
};

const DAYS: DayConfig[] = [
  { day: "Lunes", enabled: true, start: "09:00", end: "18:00", breakStart: "13:00", breakEnd: "14:00" },
  { day: "Martes", enabled: true, start: "09:00", end: "18:00", breakStart: "13:00", breakEnd: "14:00" },
  { day: "Miercoles", enabled: true, start: "09:00", end: "18:00", breakStart: "13:00", breakEnd: "14:00" },
  { day: "Jueves", enabled: true, start: "09:00", end: "18:00", breakStart: "13:00", breakEnd: "14:00" },
  { day: "Viernes", enabled: true, start: "09:00", end: "18:00", breakStart: "13:00", breakEnd: "14:00" },
  { day: "Sabado", enabled: true, start: "09:00", end: "14:00", breakStart: "00:00", breakEnd: "00:00" },
  { day: "Domingo", enabled: false, start: "00:00", end: "00:00", breakStart: "00:00", breakEnd: "00:00" },
];

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:3001";

export default function Page() {
  const [status, setStatus] = useState<BaileysStatus | null>(null);
  const [loadingStatus, setLoadingStatus] = useState(false);
  const [phone, setPhone] = useState("+5491112345678");
  const [pairingCode, setPairingCode] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<string>("");

  const [services, setServices] = useState<ServiceItem[]>([]);
  const [schedule, setSchedule] = useState<DayConfig[]>(DAYS);
  const [newService, setNewService] = useState<ServiceItem>({
    name: "",
    durationMinutes: 30,
    price: 10000,
  });

  const statusLabel = useMemo(() => {
    if (!status) return "Sin datos";
    if (status.connected) return "Conectado";
    if (status.connecting) return "Conectando";
    return "Desconectado";
  }, [status]);

  useEffect(() => {
    const storedServices = window.localStorage.getItem("mi-turno-services");
    const storedSchedule = window.localStorage.getItem("mi-turno-schedule");

    if (storedServices) {
      setServices(JSON.parse(storedServices) as ServiceItem[]);
    }

    if (storedSchedule) {
      setSchedule(JSON.parse(storedSchedule) as DayConfig[]);
    }
  }, []);

  useEffect(() => {
    window.localStorage.setItem("mi-turno-services", JSON.stringify(services));
  }, [services]);

  useEffect(() => {
    window.localStorage.setItem("mi-turno-schedule", JSON.stringify(schedule));
  }, [schedule]);

  useEffect(() => {
    void fetchStatus();
    const timer = setInterval(() => {
      void fetchStatus();
    }, 3000);

    return () => clearInterval(timer);
  }, []);

  async function fetchStatus() {
    setLoadingStatus(true);
    try {
      const response = await fetch(`${API_URL}/baileys/status`);
      const data = (await response.json()) as BaileysStatus & { ok: boolean };
      setStatus(data);
    } catch (_error) {
      setFeedback("No pude leer el estado de WhatsApp. Revisa backend y CORS.");
    } finally {
      setLoadingStatus(false);
    }
  }

  async function connect() {
    setFeedback("");
    await fetch(`${API_URL}/baileys/connect`, { method: "POST" });
    await fetchStatus();
  }

  async function reconnect(clearAuth: boolean) {
    setFeedback("");
    const response = await fetch(`${API_URL}/baileys/reconnect`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ clearAuth }),
    });
    const data = (await response.json()) as { ok: boolean; message?: string; error?: string };
    setFeedback(data.ok ? data.message ?? "Reconectado." : data.error ?? "Fallo reconexion.");
    await fetchStatus();
  }

  async function generatePairingCode() {
    setFeedback("");
    const response = await fetch(`${API_URL}/baileys/pairing-code`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ phoneE164: phone }),
    });

    const data = (await response.json()) as {
      ok: boolean;
      pairingCode?: string;
      expiresAt?: string;
      error?: string;
    };

    if (!data.ok) {
      setFeedback(data.error ?? "No se pudo generar codigo.");
      return;
    }

    setPairingCode(data.pairingCode ?? null);
    setFeedback(data.expiresAt ? `Codigo vigente hasta ${new Date(data.expiresAt).toLocaleTimeString()}.` : "Codigo generado.");
    await fetchStatus();
  }

  function addService(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!newService.name.trim()) return;

    setServices((prev) => [...prev, { ...newService, name: newService.name.trim() }]);
    setNewService({ name: "", durationMinutes: 30, price: 10000 });
  }

  function removeService(index: number) {
    setServices((prev) => prev.filter((_, itemIndex) => itemIndex !== index));
  }

  function updateSchedule(index: number, patch: Partial<DayConfig>) {
    setSchedule((prev) =>
      prev.map((day, dayIndex) => (dayIndex === index ? { ...day, ...patch } : day)),
    );
  }

  return (
    <main>
      <section className="top">
        <h1>Mi Turno - Panel de configuracion</h1>
        <p>Configura una vez en web y opera todos los dias por WhatsApp.</p>
      </section>

      <section className="grid">
        <article className="card">
          <h2>Vinculacion de WhatsApp</h2>
          <p className="muted">Estado actual del numero del barbero.</p>
          <p className={`status ${status?.connected ? "ok" : "warn"}`}>{loadingStatus ? "Cargando..." : statusLabel}</p>
          {status?.lastDisconnectReason ? <p className="muted">Ultima causa: {status.lastDisconnectReason}</p> : null}

          <div className="row">
            <button className="primary" onClick={connect} type="button">Iniciar conexion</button>
            <button onClick={() => void reconnect(false)} type="button">Reconectar</button>
            <button onClick={() => void reconnect(true)} type="button">Reconectar y limpiar</button>
          </div>

          <p className="muted" style={{ marginTop: 12 }}>
            Si estas en soporte presencial, usa la pantalla asistida: {" "}
            <a className="link" href={`${API_URL}/baileys/onboarding`} target="_blank" rel="noreferrer">
              abrir onboarding QR
            </a>
          </p>

          <label htmlFor="phone">Telefono del barbero (E164)</label>
          <input id="phone" value={phone} onChange={(event) => setPhone(event.target.value)} />
          <div className="row">
            <button type="button" onClick={generatePairingCode}>Generar codigo sin QR</button>
          </div>
          {pairingCode ? <p className="status">Codigo: {pairingCode}</p> : null}
          {feedback ? <p className="muted">{feedback}</p> : null}
        </article>

        <article className="card">
          <h2>Servicios</h2>
          <p className="muted">Carga precios y duracion una sola vez.</p>
          <form onSubmit={addService}>
            <label htmlFor="service-name">Nombre</label>
            <input
              id="service-name"
              value={newService.name}
              onChange={(event) => setNewService((prev) => ({ ...prev, name: event.target.value }))}
              placeholder="Corte clasico"
            />
            <label htmlFor="service-duration">Duracion (min)</label>
            <input
              id="service-duration"
              type="number"
              min={10}
              step={5}
              value={newService.durationMinutes}
              onChange={(event) =>
                setNewService((prev) => ({ ...prev, durationMinutes: Number(event.target.value) || 30 }))
              }
            />
            <label htmlFor="service-price">Precio</label>
            <input
              id="service-price"
              type="number"
              min={0}
              step={500}
              value={newService.price}
              onChange={(event) => setNewService((prev) => ({ ...prev, price: Number(event.target.value) || 0 }))}
            />
            <div className="row">
              <button className="primary" type="submit">Agregar servicio</button>
            </div>
          </form>

          <table>
            <thead>
              <tr>
                <th>Servicio</th>
                <th>Duracion</th>
                <th>Precio</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {services.map((item, index) => (
                <tr key={`${item.name}-${index}`}>
                  <td>{item.name}</td>
                  <td>{item.durationMinutes} min</td>
                  <td>${item.price}</td>
                  <td>
                    <button type="button" onClick={() => removeService(index)}>Eliminar</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </article>

        <article className="card" style={{ gridColumn: "1 / -1" }}>
          <h2>Horarios semanales</h2>
          <p className="muted">Definicion visual para evitar comando por comando en WhatsApp.</p>

          <table>
            <thead>
              <tr>
                <th>Dia</th>
                <th>Activo</th>
                <th>Inicio</th>
                <th>Fin</th>
                <th>Pausa inicio</th>
                <th>Pausa fin</th>
              </tr>
            </thead>
            <tbody>
              {schedule.map((day, index) => (
                <tr key={day.day}>
                  <td>{day.day}</td>
                  <td>
                    <input
                      type="checkbox"
                      checked={day.enabled}
                      onChange={(event) => updateSchedule(index, { enabled: event.target.checked })}
                    />
                  </td>
                  <td>
                    <input
                      type="time"
                      value={day.start}
                      onChange={(event) => updateSchedule(index, { start: event.target.value })}
                      disabled={!day.enabled}
                    />
                  </td>
                  <td>
                    <input
                      type="time"
                      value={day.end}
                      onChange={(event) => updateSchedule(index, { end: event.target.value })}
                      disabled={!day.enabled}
                    />
                  </td>
                  <td>
                    <input
                      type="time"
                      value={day.breakStart}
                      onChange={(event) => updateSchedule(index, { breakStart: event.target.value })}
                      disabled={!day.enabled}
                    />
                  </td>
                  <td>
                    <input
                      type="time"
                      value={day.breakEnd}
                      onChange={(event) => updateSchedule(index, { breakEnd: event.target.value })}
                      disabled={!day.enabled}
                    />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </article>
      </section>
    </main>
  );
}
