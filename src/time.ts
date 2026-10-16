// Europe/Brussels time helpers. Workers run in UTC.
// Intl.formatToParts is slow (~10 µs per call, thousands per De Lijn timetable), so we only use Intl to learn the
// UTC offset once per UTC hour (DST switches on whole UTC hours) and do the rest with plain Date arithmetic.

const TZ = "Europe/Brussels";

const offsetFmt = new Intl.DateTimeFormat("en-GB", {
  timeZone: TZ,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});
const offsets = new Map<number, number>();

/** Brussels UTC offset in minutes (60 or 120) at this instant. */
export function offsetMin(epochSec: number): number {
  const hourKey = Math.floor(epochSec / 3600);
  let off = offsets.get(hourKey);
  if (off === undefined) {
    const t = hourKey * 3600;
    const p = Object.fromEntries(offsetFmt.formatToParts(new Date(t * 1000)).map((x) => [x.type, x.value]));
    off = Math.round((Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute) / 1000 - t) / 60);
    if (offsets.size > 5000) offsets.clear();
    offsets.set(hourKey, off);
  }
  return off;
}

const pad = (n: number) => String(n).padStart(2, "0");

export function brusselsParts(epochSec: number) {
  const d = new Date((epochSec + offsetMin(epochSec) * 60) * 1000);
  return {
    y: String(d.getUTCFullYear()),
    m: pad(d.getUTCMonth() + 1),
    d: pad(d.getUTCDate()),
    hh: pad(d.getUTCHours()),
    mm: pad(d.getUTCMinutes()),
    ss: pad(d.getUTCSeconds()),
  };
}

/** "08:12" */
export function hhmm(epochSec: number): string {
  const p = brusselsParts(epochSec);
  return `${p.hh}:${p.mm}`;
}

/** "2026-10-06" */
export function isoDate(epochSec: number): string {
  const p = brusselsParts(epochSec);
  return `${p.y}-${p.m}-${p.d}`;
}

/** "2026-10-06 08:12" */
export function isoDateTime(epochSec: number): string {
  return `${isoDate(epochSec)} ${hhmm(epochSec)}`;
}

export const nowSec = () => Math.floor(Date.now() / 1000);

/** Seconds of delay -> whole minutes (iRail reports seconds). */
export const delayMin = (sec: string | number | undefined) => Math.round(Number(sec ?? 0) / 60);

/**
 * Convert optional user input ("YYYY-MM-DD", "HH:mm") to iRail's date=ddmmyy / time=hhmm.
 * Missing parts default to "now" in Brussels. `shiftMin` moves the time (e.g. -5 to show context).
 */
export function irailDateTime(date?: string, time?: string, shiftMin = 0): { date: string; time: string } {
  const now = brusselsParts(nowSec());
  const [y, m, d] = (date ?? `${now.y}-${now.m}-${now.d}`).split("-").map(Number);
  const [h, mi] = (time ?? `${now.hh}:${now.mm}`).split(":").map(Number);
  // Do the shift with a UTC Date as a plain calendar calculator (no TZ involved).
  const t = new Date(Date.UTC(y, m - 1, d, h, mi + shiftMin));
  const pad = (n: number) => String(n).padStart(2, "0");
  return {
    date: `${pad(t.getUTCDate())}${pad(t.getUTCMonth() + 1)}${String(t.getUTCFullYear()).slice(2)}`,
    time: `${pad(t.getUTCHours())}${pad(t.getUTCMinutes())}`,
  };
}

export const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
export const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** "2026-10-06T08:12:00" (Brussels local, no offset) -> unix seconds. Handles DST via Intl. */
export function brusselsLocalToEpoch(s: string): number {
  // "YYYY-MM-DDTHH:mm[:ss]" by position (hot path: thousands per De Lijn timetable).
  if (typeof s !== "string" || s.length < 16 || s[4] !== "-" || s[10] !== "T") return NaN;
  const y = +s.slice(0, 4), mo = +s.slice(5, 7), d = +s.slice(8, 10), h = +s.slice(11, 13), mi = +s.slice(14, 16);
  const se = s.length >= 19 ? +s.slice(17, 19) : 0;
  if ([y, mo, d, h, mi, se].some(Number.isNaN)) return NaN;
  const asUtc = Date.UTC(y, mo - 1, d, h, mi, se) / 1000;
  // Offset at the guessed instant, then re-check (correct across DST switches).
  const off = offsetMin(asUtc - offsetMin(asUtc) * 60);
  return asUtc - off * 60;
}
