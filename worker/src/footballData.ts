import { isoDate } from "./dates.js";

// Proveedor de fixtures para el Worker: football-data.org v4 (plan gratuito).
// Cubre las 5 ligas europeas con temporada actual, crests y tla. EC1 no está
// cubierto: esos fixtures llegan por relay local (POST /api/ingest).
// Consumo: 1 req por liga y día (~6/día frente a 10 req/min sin tope mensual).
const BASE = "https://api.football-data.org/v4/competitions";

interface FootballDataTeam {
  name: string;
  shortName: string;
  tla: string;
  crest: string;
}

interface FootballDataMatch {
  id: number;
  utcDate: string;
  status: string;
  homeTeam: FootballDataTeam;
  awayTeam: FootballDataTeam;
  score: { fullTime: { home: number | null; away: number | null } };
}

export interface ProviderFixture {
  id: string;
  date: string;
  home: string;
  away: string;
  homeShort: string;
  awayShort: string;
  homeLogo: string | null;
  awayLogo: string | null;
  status: string;
  homeScore: number | null;
  awayScore: number | null;
}

// shortName = nombre de entrenamiento (el modelo global se entrenó con
// football-data.co.uk): resolución directa sin overrides nuevos en general.
function mapStatus(status: string): string | null {
  if (status === "TIMED" || status === "SCHEDULED") return "pre";
  if (status === "IN_PLAY" || status === "PAUSED") return "in";
  if (status === "FINISHED" || status === "AWARDED") return "post";
  // POSTPONED/SUSPENDED/CANCELED: se omiten hasta su reprogramación.
  return null;
}

function logoOf(url: string): string | null {
  return url.startsWith("http") ? url : null;
}

function scoreOf(n: number | null): number | null {
  return typeof n === "number" && Number.isFinite(n) ? n : null;
}

function toFixture(m: FootballDataMatch): ProviderFixture | null {
  const status = mapStatus(m.status);
  if (status === null) return null;
  return {
    id: `fdata-${m.id}`,
    date: m.utcDate,
    home: m.homeTeam.shortName || m.homeTeam.name,
    away: m.awayTeam.shortName || m.awayTeam.name,
    homeShort: m.homeTeam.tla || "",
    awayShort: m.awayTeam.tla || "",
    homeLogo: logoOf(m.homeTeam.crest),
    awayLogo: logoOf(m.awayTeam.crest),
    status,
    homeScore: scoreOf(m.score.fullTime.home),
    awayScore: scoreOf(m.score.fullTime.away),
  };
}

export async function fetchLeagueFixtures(
  fdCode: string,
  timeZone: string,
  apiKey: string,
): Promise<ProviderFixture[]> {
  if (!apiKey) throw new Error("FOOTBALL_DATA_KEY no configurado");
  // Ventana hacia atrás para re-consultar jugados y asentar resultados.
  // Sin parámetro de temporada: dateFrom/dateTo cruzan temporadas solos.
  const url = `${BASE}/${fdCode}/matches?dateFrom=${isoDate(-2, timeZone)}&dateTo=${isoDate(14, timeZone)}`;
  const res = await fetch(url, {
    headers: { "X-Auth-Token": apiKey },
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) throw new Error(`football-data.org ${fdCode}: ${res.status}`);
  const data = (await res.json()) as { message?: string; matches?: FootballDataMatch[] };
  if (typeof data.message === "string" && !Array.isArray(data.matches)) {
    throw new Error(`football-data.org ${fdCode}: ${data.message}`);
  }
  return (data.matches ?? []).map(toFixture).filter((f): f is ProviderFixture => f !== null);
}
