                                                                                                  export type ParsedIntent = {
  intent: "book" | "view_appointments" | "cancel" | "greeting" | "availability" | "unknown";
  serviceName?: string;
  barberName?: string;
  date?: string;
  time?: string;
  customerName?: string;
};

const TIMEZONE = "America/Mexico_City";

const GREETING_PATTERNS = [
  /^(hola|buenos?\\s*d[ií]as|buenas?\\s*(tardes?|noches?)|saludos?|qué tal|hey)\\??$/i,
  /^(gracias|gracias?|muchas?\\s?gracias)$/i,
  /^start$/i,
];

const BOOK_PATTERNS = [
  /agend/,
  /reserv/,
  /turno/,
  /horario/,
  /disponible/,
  /cita\s+(para|el|mañana|hoy|pasado)/i,
  /(?:quiero|necesito|dame|agar[rg]e|agárme|quedar|quédame|separar|sepárame|pido)\s+(?:una?\s+)?(?:cita|hora|horario)/i,
  /pedir\s+(?:una?\s+)?(?:cita|hora)/i,
  /tengo\s+disponible/i,
];

const CANCEL_PATTERNS = [
  /cancel[ao]/i,
  /eliminar\s*(mi\s*)?cita/i,
  /borrar\s*(mi\s*)?cita/i,
];

const AFFIRMATIVE_PATTERNS = [
  /^s[ií]$/i,
  /^ok$/i,
  /^okay$/i,
  /^confirmar$/i,
  /^confirmo$/i,
  /^dale$/i,
  /^perfecto$/i,
  /^genial$/i,
  /^bueno$/i,
  /^va$/i,
  /^por\s+supuesto$/i,
  /^adelante$/i,
  /^así\s+es$/i,
  /^así\s+mismo$/i,
  /^exacto$/i,
  /^correcto$/i,
  /^si\s+confirmo$/i,
  /^si\s+por\s+favor$/i,
  /^sí\s+confirmo$/i,
  /^sí\s+por\s+favor$/i,
];

const NEGATIVE_PATTERNS = [
  /^no$/i,
  /^nah$/i,
  /^nope$/i,
  /^cancelar$/i,
  /^cancelo$/i,
  /^otro$/i,
  /^cambiar$/i,
  /^diferente$/i,
  /^mejor\s+otro$/i,
  /^no\s+quiero$/i,
  /^mejor\s+no$/i,
];

const ANY_BARBER_PATTERNS = [
  /cualquier[ae]?/i,
  /da\s+igual/i,
  /me\s+da\s+igual/i,
  /sin\s+preferencia/i,
  /el\s+que\s+(?:esté|sea|aparezc|encuentr)/i,
  /cualquiera\s+(?:está|está|bien)/i,
];

const NUMBER_WORDS: Record<string, number> = {
  "uno": 1, "un": 1, "una": 1,
  "dos": 2,
  "tres": 3,
  "cuatro": 4,
  "cinco": 5,
  "seis": 6,
  "siete": 7,
  "ocho": 8,
  "nueve": 9,
  "diez": 10,
  "primero": 1, "primera": 1, "primer": 1,
  "segundo": 2, "segunda": 2,
  "tercero": 3, "tercera": 3,
  "cuarto": 4, "cuarta": 4,
  "quinto": 5, "quinta": 5,
};

const SELECTION_PREFIX_PATTERNS = [
  /^(?:opci[oó]n|opc|numero|número|n\.?)\s*\.?\s*(\d+)$/i,
  /^(?:la|el)\s+(\d+)$/i,
  /^[1-9]\s*[\.\):\-]?\s*$/,
];

const VIEW_PATTERNS = [
  /^mis\s*citas$/i,
  /ver\s*(mis\s*)?citas/i,
  /tengo\s*(una?)?\s*cita/i,
  /mis\s*citas\s*(agendadas|programadas)?$/i,
];

const AVAILABILITY_PATTERNS = [
  /disponibilidad|disponible/i,
  /horarios?\s*(hay|tienen|disponibles?)/i,
  /qué\s*horarios?\s*(hay|tienen)/i,
  /qué\s*días?\s*(hay|tienen|libre)/i,
  /ver\s*(los\s*)?horarios?/i,
  /qué\s*horas?\s*(hay|tienen)/i,
  /tienen\s*horario/i,
  /a\s*qué\s*horas?\s*(están|están)/i,
];

const DAYS_ES: Record<string, number> = {
  domingo: 0,
  dom: 0,
  lunes: 1,
  lun: 1,
  martes: 2,
  mar: 2,
  miércoles: 3,
  miercoles: 3,
  mié: 3,
  jue: 3,
  jueves: 4,
  viernes: 5,
  vie: 5,
  sábado: 6,
  sabado: 6,
  sáb: 6,
};

const MONTHS_ES: Record<string, number> = {
  enero: 0,
  feb: 1,
  febrero: 1,
  mar: 2,
  marzo: 2,
  abr: 3,
  abril: 3,
  may: 4,
  mayo: 4,
  jun: 5,
  junio: 5,
  jul: 6,
  julio: 6,
  ago: 7,
  agosto: 7,
  sep: 8,
  septiembre: 8,
  oct: 9,
  octubre: 9,
  nov: 10,
  noviembre: 10,
  dic: 11,
  diciembre: 11,
};

const SERVICE_ALIASES: Record<string, string[]> = {
  corte: ["corte", "cortar", "cortarme", "pelo", "cabello", "degradado", "corte de pelo", "corte de cabello"],
  barba: ["barba", "rasurar", "afeitar", "barba y bigote"],
  cejas: ["cejas", "diseño de cejas", "perfilado de cejas"],
};

const TIME_PATTERNS = [
  /(?:a\s+las?\s*)?(\d{1,2})\s*(?:am|pm|hrs?|horas?|hs)\b/i,
  /(\d{1,2})\s*:\s*(\d{2})/,
  /\ba\s+las?\s*(\d{1,2})\b(?!\s*(?:am|pm|hrs?|horas?|hs)\b)/i,
];

const DATE_RELATIVE_PATTERNS = [
  { regex: /pasad[oa]?\s*mañana|pasad[oa]?\s*maniana/i, offset: 2 },
  { regex: /mañana|maniana/i, offset: 1 },
  { regex: /hoy/i, offset: 0 },
];

export function parseNaturalLanguage(text: string): ParsedIntent {
  const lower = text.toLowerCase().trim();
  
  if (GREETING_PATTERNS.some(p => p.test(lower))) {
    return { intent: "greeting" };
  }
  
  if (CANCEL_PATTERNS.some(p => p.test(lower))) {
    return { intent: "cancel" };
  }
  
  if (VIEW_PATTERNS.some(p => p.test(lower))) {
    return { intent: "view_appointments" };
  }
  
  const hasBookIntent = BOOK_PATTERNS.some(p => p.test(lower));
  const hasService = detectService(lower);
  const hasBarber = detectBarber(lower);
  const dateTimeInfo = extractDateTime(lower);
  const name = extractName(lower);
  
  if (hasBookIntent || hasService || dateTimeInfo) {
    return {
      intent: "book",
      serviceName: hasService,
      barberName: hasBarber,
      date: dateTimeInfo?.date,
      time: dateTimeInfo?.time,
      customerName: name,
    };
  }
  
  if (AVAILABILITY_PATTERNS.some(p => p.test(lower))) {
    const availabilityDateTime = extractDateTime(lower);
    return {
      intent: "availability",
      date: availabilityDateTime?.date,
      time: availabilityDateTime?.time,
    };
  }
  
  return { intent: "unknown" };
}

function detectService(text: string): string | undefined {
  for (const [service, aliases] of Object.entries(SERVICE_ALIASES)) {
    for (const alias of aliases) {
      if (text.includes(alias)) {
        return service;
      }
    }
  }
  return undefined;
}

function detectBarber(text: string): string | undefined {
  const barberPatterns = [
    /(?:con|para)\s+([A-ZÁÉÍÓÚÑ][a-záéíóúñ]+)/,
    /con\\s+el\\s+([A-ZÁÉÍÓÚÑ][a-záéíóúñ]+)/i,
  ];
  
  for (const pattern of barberPatterns) {
    const match = text.match(pattern);
    if (match && match[1]) {
      return match[1].trim();
    }
  }
  return undefined;
}

export function extractDateTime(text: string): { date: string; time: string } | null {
  let daysOffset: number | null = null;
  let timeStr: string | null = null;
  
  for (const { regex, offset } of DATE_RELATIVE_PATTERNS) {
    if (regex.test(text)) {
      daysOffset = offset;
      break;
    }
  }
  
  if (daysOffset === null) {
    const dayMatch = text.match(/\b(\d{1,2})\b/);
    if (dayMatch && text.match(/\b(d[e']|del|dia|d[ií]a)\b/i)) {
      const day = parseInt(dayMatch[1]);
      const monthMatch = text.match(new RegExp(`\\b(${Object.keys(MONTHS_ES).join("|")})\\b`, "i"));
      if (monthMatch) {
        const month = MONTHS_ES[monthMatch[1].toLowerCase()];
        const year = new Date().getFullYear();
        const targetDate = new Date(year, month, day);
        if (targetDate >= new Date()) {
          daysOffset = Math.ceil((targetDate.getTime() - new Date().setHours(0,0,0,0)) / (1000 * 60 * 60 * 24));
        }
      }
    }
    
    for (const dayName of Object.keys(DAYS_ES)) {
      if (text.includes(dayName)) {
        daysOffset = getNextDayOffset(DAYS_ES[dayName]);
        break;
      }
    }
  }
  
  for (const pattern of TIME_PATTERNS) {
    const match = text.match(pattern);
    if (match) {
      let hours = parseInt(match[1]);
      const isPM = text.includes("pm") || (match[0].includes("pm") && hours !== 12);
      const isAM = text.includes("am") || (match[0].includes("am") && hours === 12);
      
      if (isPM && hours < 12) hours += 12;
      if (isAM && hours === 12) hours = 0;
      
      if (match[2]) {
        const minutes = parseInt(match[2]);
        timeStr = `${hours.toString().padStart(2, "0")}:${minutes.toString().padStart(2, "0")}`;
      } else {
        timeStr = `${hours.toString().padStart(2, "0")}:00`;
      }
      break;
    }
  }
  
  if (daysOffset !== null || timeStr !== null) {
    return {
      date: daysOffset !== null ? getDateString(daysOffset) : "",
      time: timeStr || "",
    };
  }
  
  return null;
}

function getNextDayOffset(targetWeekday: number): number {
  const now = new Date();
  const dayIndex = now.getDay();
  let diff = targetWeekday - dayIndex;
  if (diff <= 0) diff += 7;
  return diff;
}

function getDateString(daysOffset: number): string {
  const date = new Date();
  date.setDate(date.getDate() + daysOffset);
  
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  
  return `${year}-${month}-${day}`;
}

function extractName(text: string): string | undefined {
  const patterns = [
    /(?:me\s+llamo|soy|mi\s+nombre\s+es)\s+([A-ZÁÉÍÓÚÑ][a-záéíóúñ]+\s+[A-ZÁÉÍÓÚÑ][a-záéíóúñ]+)/i,
    /(?:me\s+llamo|soy|mi\s+nombre\s+es)\s+([A-ZÁÉÍÓÚÑ][a-záéíóúñ]+)/i,
    /^(me\s+llamo|soy)\s+/i,
  ];
  
  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match && match[1]) {
      return match[1].trim();
    }
  }
  
  return undefined;
}

export function parseNumericSelection(text: string, maxOptions: number): number | null {
  const trimmed = text.toLowerCase().trim();
  
  if (trimmed === "1" || trimmed === "2") {
    return parseInt(trimmed);
  }
  
  if (/^[1-9]$/.test(trimmed)) {
    const num = parseInt(trimmed);
    if (num >= 1 && num <= maxOptions) {
      return num;
    }
  }
  
  const prefixMatch = trimmed.match(/^(?:opci[oó]n|opc|numero|número|n\.?|la\s*|el\s*)\s*\.?\s*(\d+)$/i);
  if (prefixMatch) {
    const num = parseInt(prefixMatch[1]);
    if (num >= 1 && num <= maxOptions) {
      return num;
    }
  }
  
  const wordNum = NUMBER_WORDS[trimmed.replace(/[^a-záéíóúñ]/gi, '')];
  if (wordNum !== undefined && wordNum >= 1 && wordNum <= maxOptions) {
    return wordNum;
  }
  
  const endWithPeriod = trimmed.match(/^(\d+)[\.\):\-]?$/);
  if (endWithPeriod) {
    const num = parseInt(endWithPeriod[1]);
    if (num >= 1 && num <= maxOptions) {
      return num;
    }
  }
  
  return null;
}

export function isAffirmativeResponse(text: string): boolean {
  const trimmed = text.toLowerCase().trim();
  return AFFIRMATIVE_PATTERNS.some(p => p.test(trimmed)) || trimmed === "1";
}

export function isNegativeResponse(text: string): boolean {
  const trimmed = text.toLowerCase().trim();
  return NEGATIVE_PATTERNS.some(p => p.test(trimmed)) || trimmed === "2";
}

export function hasBarberPreferenceAny(text: string): boolean {
  const trimmed = text.toLowerCase().trim();
  return ANY_BARBER_PATTERNS.some(p => p.test(trimmed));
}

export function matchPartialTimeSlot(
  text: string,
  slots: { startsAt: string }[]
): { startsAt: string; endsAt: string } | null {
  const trimmed = text.toLowerCase().trim();
  
  const exact = isTimeSlotAvailable(slots, trimmed);
  if (exact) return exact;
  
  const justNumber = trimmed.replace(/[^0-9]/g, '');
  if (justNumber && justNumber.length <= 2) {
    const targetHour = parseInt(justNumber);
    const hasPM = trimmed.includes('pm');
    const hasAM = trimmed.includes('am');
    
    let matches: { slot: { startsAt: string }; hour12: number; isPM: boolean }[] = [];
    
    for (const slot of slots) {
      const slotDate = new Date(slot.startsAt);
      const hour24 = slotDate.getHours();
      const hour12 = hour24 % 12 || 12;
      const isPM = hour24 >= 12;
      
      if (hour12 === targetHour || hour24 === targetHour) {
        matches.push({ slot, hour12, isPM });
      }
    }
    
    if (matches.length === 0) return null;
    
    if (hasPM || hasAM) {
      const match = matches.find(m => (hasPM && m.isPM) || (hasAM && !m.isPM));
      if (match) {
        const slotDate = new Date(match.slot.startsAt);
        const endsAt = new Date(slotDate.getTime() + 30 * 60 * 1000);
        return { startsAt: match.slot.startsAt, endsAt: endsAt.toISOString() };
      }
      return null;
    }
    
    const match = matches[0];
    const slotDate = new Date(match.slot.startsAt);
    const endsAt = new Date(slotDate.getTime() + 30 * 60 * 1000);
    return { startsAt: match.slot.startsAt, endsAt: endsAt.toISOString() };
  }
  
  return null;
}

export function findServiceByName(services: { id: string; name: string }[], query: string): string | null {
  const lower = query.toLowerCase();
  
  for (const [canonical, aliases] of Object.entries(SERVICE_ALIASES)) {
    if (aliases.some(a => lower.includes(a))) {
      const found = services.find(s => s.name.toLowerCase().includes(canonical) || canonical.includes(s.name.toLowerCase()));
      if (found) return found.id;
      
      for (const service of services) {
        const serviceLower = service.name.toLowerCase();
        if (aliases.some(a => serviceLower.includes(a) || a.includes(serviceLower))) {
          return service.id;
        }
      }
    }
  }
  
  const direct = services.find(s => s.name.toLowerCase().includes(lower));
  return direct?.id || null;
}

export function findBarberByName(barbers: { id: string; name: string }[], query: string): string | null {
  if (!query) return null;
  
  const lower = query.toLowerCase();
  const found = barbers.find(b => b.name.toLowerCase().includes(lower));
  return found?.id || null;
}

export function isTimeSlotAvailable(slots: { startsAt: string }[], targetTime: string): { startsAt: string; endsAt: string } | null {
  if (!targetTime) return null;
  
  const [targetHours, targetMinutes] = targetTime.split(":").map(Number);
  
  for (const slot of slots) {
    const slotDate = new Date(slot.startsAt);
    if (slotDate.getHours() === targetHours && slotDate.getMinutes() === targetMinutes) {
      const endsAt = new Date(slotDate.getTime() + 30 * 60 * 1000);
      return {
        startsAt: slot.startsAt,
        endsAt: endsAt.toISOString(),
      };
    }
  }
  
  let closest: { startsAt: string; endsAt: string } | null = null;
  let minDiff = Infinity;
  
  for (const slot of slots) {
    const slotDate = new Date(slot.startsAt);
    const diff = Math.abs(slotDate.getHours() * 60 + slotDate.getMinutes() - (targetHours * 60 + targetMinutes));
    if (diff < minDiff) {
      minDiff = diff;
      closest = {
        startsAt: slot.startsAt,
        endsAt: new Date(slotDate.getTime() + 30 * 60 * 1000).toISOString(),
      };
    }
  }
  
  if (minDiff <= 60) {
    return closest;
  }
  
  return null;
}
