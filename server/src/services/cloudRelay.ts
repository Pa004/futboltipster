import { CLOUD_SYNC_TOKEN, CLOUD_SYNC_URL } from "../config.js";
import { db } from "../db.js";

// Relay EC1 al Worker de Cloudflare (POST /api/ingest). Las ligas europeas
// van por football-data.org en cloud con otros ids: reenviarlas duplicaría
// filas, así que el relay es solo EC1. Best-effort: nunca rompe el sync local.
export async function pushCloudFixtures(url = CLOUD_SYNC_URL, token = CLOUD_SYNC_TOKEN): Promise<void> {
  if (!url || !token) return; // relay desactivado
  try {
    const cutoff = new Date(Date.now() - 2 * 86_400_000).toISOString().slice(0, 10);
    const rows = db
      .prepare(
        `SELECT id, league, date, home, away, home_short, away_short, home_logo, away_logo,
                status, home_score, away_score
         FROM fixtures WHERE league = 'EC1' AND date >= ?`,
      )
      .all(cutoff) as {
      id: string;
      league: string;
      date: string;
      home: string;
      away: string;
      home_short: string | null;
      away_short: string | null;
      home_logo: string | null;
      away_logo: string | null;
      status: string;
      home_score: number | null;
      away_score: number | null;
    }[];
    if (rows.length === 0) return;
    const res = await fetch(`${url}/api/ingest`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-cloud-token": token },
      body: JSON.stringify({
        fixtures: rows.map((r) => ({
          id: r.id,
          league: r.league,
          date: r.date,
          home: r.home,
          away: r.away,
          homeShort: r.home_short ?? "",
          awayShort: r.away_short ?? "",
          homeLogo: r.home_logo,
          awayLogo: r.away_logo,
          status: r.status,
          homeScore: r.home_score,
          awayScore: r.away_score,
        })),
      }),
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) throw new Error(`cloud /ingest: ${res.status}`);
    console.log(`[relay] EC1 fixtures=${rows.length}`);
  } catch (err) {
    console.error("[relay]", (err as Error).message);
  }
}
