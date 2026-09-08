function dayFormatter(timeZone: string): Intl.DateTimeFormat {
  // en-CA => YYYY-MM-DD.
  return new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
}

// "Hoy" como fecha local (YYYY-MM-DD) en la zona dada, no en UTC.
export function localToday(timeZone: string): string {
  return dayFormatter(timeZone).format(new Date());
}

// YYYY-MM-DD del día local desplazado N días (formato que pide football-data.org).
export function isoDate(offsetDays: number, timeZone: string): string {
  const target = new Date(Date.now() + offsetDays * 86_400_000);
  return dayFormatter(timeZone).format(target);
}
