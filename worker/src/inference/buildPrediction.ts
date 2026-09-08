// Orquestación de predicción. Espejo de app/api.py build_prediction:
// la matriz FT se calcula una sola vez y se comparte con predict.
import type { Artifacts } from "./artifacts.js";
import { countGroupNames } from "./artifacts.js";
import { predictCount } from "./countModel.js";
import { predictDixonColes, scoreMatrix, type DixonColesModel } from "./dixonColes.js";
import {
  AH_LINES,
  asianHandicap,
  cleanSheet,
  correctScoreTop,
  countHandicap,
  COUNT_GROUPS,
  doubleChance,
  firstEvent,
  FT_LINES,
  htFtMarkets,
  HT_LINES,
  mostMarkets,
  oddEven,
  teamTotals,
  TEAM_TOTAL_LINES,
  teamTotalsPmf,
  totalMarkets,
  totalMarketsPmf,
} from "./markets.js";

export function buildPrediction(
  home: string,
  away: string,
  baseModel: DixonColesModel,
  art: Artifacts,
): Record<string, unknown> {
  // La matriz se calcula una sola vez y se comparte con predict (evita doble grid).
  const mat = scoreMatrix(baseModel, home, away);
  const base = predictDixonColes(baseModel, home, away, mat);

  const markets: Record<string, unknown> = {
    ft: {
      double_chance: doubleChance(base.probabilities),
      over_under: totalMarkets(mat, FT_LINES),
      asian_handicap: asianHandicap(mat, AH_LINES),
      odd_even: oddEven(mat),
      team_totals: teamTotals(mat, TEAM_TOTAL_LINES),
      clean_sheet: cleanSheet(mat),
      correct_score_top: correctScoreTop(mat),
    },
    first_goal: firstEvent(base.expected_goals.home, base.expected_goals.away),
  };

  if (art.ht !== null) {
    const htPred = predictDixonColes(art.ht, home, away);
    const htMat = scoreMatrix(art.ht, home, away);
    const htProbs = htPred.probabilities;
    markets["ht"] = {
      probabilities: htProbs,
      double_chance: doubleChance(htProbs),
      over_under: totalMarkets(htMat, HT_LINES),
      btts_yes: htPred.btts_yes,
      expected_goals: htPred.expected_goals,
    };
    if (art.htftCond !== null) {
      markets["ht_ft"] = htFtMarkets([htProbs.home, htProbs.draw, htProbs.away], art.htftCond);
    }
  }

  for (const name of countGroupNames()) {
    const cm = art.counts[name];
    if (cm === undefined) continue;
    const pred = predictCount(cm, home, away);
    const lines = COUNT_GROUPS[name];
    markets[name] = {
      total: totalMarketsPmf(pred.pmf_home, pred.pmf_away, lines.total),
      team_totals: teamTotalsPmf(pred.pmf_home, pred.pmf_away, lines.team),
      most: mostMarkets(pred.pmf_home, pred.pmf_away),
      handicap: countHandicap(pred.pmf_home, pred.pmf_away, lines.handicap),
      expected: pred.expected,
    };
  }
  if ("corners" in markets) {
    const lamC = (markets["corners"] as { expected: { home: number; away: number } }).expected;
    markets["first_corner"] = firstEvent(lamC.home, lamC.away);
  }

  return { ...base, markets };
}
