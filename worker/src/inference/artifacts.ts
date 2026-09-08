// Carga de artefactos JSON (generados por ml-service/scripts/export_to_json.py)
// y selección de modelo por liga. Espejo de app/api.py Models.load/select_model.
import ftJson from "../../data/dixon_coles.json" with { type: "json" };
import ftEc1Json from "../../data/dixon_coles_ec1.json" with { type: "json" };
import htJson from "../../data/dixon_coles_ht.json" with { type: "json" };
import htftCondJson from "../../data/htft_cond.json" with { type: "json" };
import cornersJson from "../../data/corners.json" with { type: "json" };
import bookingsJson from "../../data/bookings.json" with { type: "json" };
import shotsOnTargetJson from "../../data/shots_on_target.json" with { type: "json" };
import foulsJson from "../../data/fouls.json" with { type: "json" };
import { COUNT_GROUPS } from "./markets.js";
import { loadCountModel, type CountModel, type CountModelData } from "./countModel.js";
import { loadDixonColes, type DixonColesData, type DixonColesModel } from "./dixonColes.js";

export interface Artifacts {
  ft: DixonColesModel;
  ftEc1: DixonColesModel | null;
  ht: DixonColesModel | null;
  htftCond: number[][] | null;
  counts: Record<string, CountModel>;
  trainedAt: string | null;
}

function asDixonColes(raw: unknown): DixonColesData {
  return raw as DixonColesData;
}

function asCountModel(raw: unknown): CountModelData {
  return raw as CountModelData;
}

function loadArtifacts(): Artifacts {
  const ft = loadDixonColes(asDixonColes(ftJson));
  const ftEc1 = loadDixonColes(asDixonColes(ftEc1Json));
  const ht = loadDixonColes(asDixonColes(htJson));
  const htftCond = (htftCondJson as { cond: number[][] }).cond;
  const counts: Record<string, CountModel> = {
    corners: loadCountModel(asCountModel(cornersJson)),
    bookings: loadCountModel(asCountModel(bookingsJson)),
    shots_on_target: loadCountModel(asCountModel(shotsOnTargetJson)),
    fouls: loadCountModel(asCountModel(foulsJson)),
  };
  // trained_at = artefacto más reciente (misma semántica que Models.load).
  const savedAt = [
    ft.saved_at,
    ftEc1.saved_at,
    ht.saved_at,
    (htftCondJson as { saved_at: string }).saved_at,
    ...Object.values(counts).map((c) => c.saved_at),
  ].filter(Boolean);
  savedAt.sort();
  return { ft, ftEc1, ht, htftCond, counts, trainedAt: savedAt.length > 0 ? savedAt[savedAt.length - 1] : null };
}

// Bundleado una vez por isolate (los JSON vienen importados, sin fetch).
export const artifacts: Artifacts = loadArtifacts();

// EC1 usa su modelo por-liga; el resto, el global. Null = artefacto ausente.
export function selectModel(art: Artifacts, leagueCode: string): DixonColesModel | null {
  if (leagueCode === "EC1") return art.ftEc1;
  return art.ft;
}

export function countGroupNames(): string[] {
  return Object.keys(COUNT_GROUPS);
}
