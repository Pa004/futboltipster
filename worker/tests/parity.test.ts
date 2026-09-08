// Paridad TS vs Python: cada golden se generó con build_prediction real
// (ml-service/scripts/generate_golden.py). Ante divergencia se corrige el TS.
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { artifacts, selectModel } from "../src/inference/artifacts.js";
import { buildPrediction } from "../src/inference/buildPrediction.js";

const ABS_TOL = 1e-9;

interface GoldenCase {
  home: string;
  away: string;
  league: string;
  expected: unknown;
}

function loadGoldens(): { file: string; home: string; away: string; league: string; expected: unknown }[] {
  const dir = join(dirname(fileURLToPath(import.meta.url)), "golden");
  return readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .sort()
    .map((file) => ({ file, ...(JSON.parse(readFileSync(join(dir, file), "utf-8")) as GoldenCase) }));
}

function closeEnough(actual: number, expected: number, path: string): void {
  const diff = Math.abs(actual - expected);
  const tol = ABS_TOL + ABS_TOL * Math.abs(expected);
  expect(diff, `${path}: ${actual} vs ${expected}`).toBeLessThanOrEqual(tol);
}

function assertParity(actual: unknown, expected: unknown, path: string): void {
  if (typeof actual === "number" && typeof expected === "number") {
    closeEnough(actual, expected, path);
    return;
  }
  if (Array.isArray(actual) && Array.isArray(expected)) {
    expect(actual.length, `${path}.length`).toBe(expected.length);
    actual.forEach((v, i) => assertParity(v, expected[i], `${path}[${i}]`));
    return;
  }
  if (actual !== null && expected !== null && typeof actual === "object" && typeof expected === "object") {
    const aKeys = Object.keys(actual).sort();
    const eKeys = Object.keys(expected as Record<string, unknown>).sort();
    expect(aKeys, `${path} keys`).toEqual(eKeys);
    for (const k of aKeys) {
      assertParity(
        (actual as Record<string, unknown>)[k],
        (expected as Record<string, unknown>)[k],
        `${path}.${k}`,
      );
    }
    return;
  }
  expect(actual, path).toBe(expected);
}

describe("paridad TS vs Python", () => {
  const goldens = loadGoldens();
  expect(goldens.length).toBeGreaterThan(0);
  for (const { file, home, away, league, expected } of goldens) {
    it(`${file}: ${home} vs ${away} (${league})`, () => {
      const model = selectModel(artifacts, league);
      expect(model).not.toBeNull();
      const actual = buildPrediction(home, away, model!, artifacts);
      assertParity(actual, expected, "$");
    });
  }
});
