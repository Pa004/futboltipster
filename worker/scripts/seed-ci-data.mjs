// Genera artefactos JSON mínimos para CI (solo typecheck/lint; los tests de
// contenido —parity, predict, routes— requieren los JSON reales de
// ml-service/scripts/export_to_json.py y corren en local, no en CI).
// Uso: node scripts/seed-ci-data.mjs [outDir]
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const outDir = resolve(process.argv[2] ?? join(dirname(fileURLToPath(import.meta.url)), "..", "data"));
mkdirSync(outDir, { recursive: true });

const dixonColes = {
  teams: ["Alfa", "Beta"],
  attack: [0.1, -0.1],
  defense: [0.05, -0.05],
  mu: 0.2,
  gamma: 0.15,
  rho: -0.05,
  n_matches: 10,
  saved_at: "2026-01-01T00:00:00",
};

const count = {
  ...dixonColes,
  form: [0.5, -0.5],
  form_beta: 0.1,
  alpha_od: 0.2,
};

const files = {
  "dixon_coles.json": dixonColes,
  "dixon_coles_ec1.json": dixonColes,
  "dixon_coles_ht.json": dixonColes,
  "corners.json": count,
  "bookings.json": count,
  "shots_on_target.json": count,
  "fouls.json": count,
  htft_cond: { cond: [[0.5, 0.3, 0.2], [0.3, 0.4, 0.3], [0.2, 0.3, 0.5]], saved_at: "2026-01-01T00:00:00" },
};

for (const [name, data] of Object.entries(files)) {
  writeFileSync(join(outDir, name.endsWith(".json") ? name : `${name}.json`), JSON.stringify(data));
}
console.log(`seed CI escrito en ${outDir}`);
