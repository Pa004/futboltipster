"""Genera vectores golden para el test de paridad TS (worker/tests/parity.test.ts).

Corre build_prediction sobre pares fijos de los artefactos reales y vuelca
inputs + outputs a worker/tests/golden/*.json. Los pares cubren global, EC1,
mismo equipo y equipo desconocido (tasas en cero).
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from app.api import build_prediction, models

GOLDEN_DIR = Path(__file__).resolve().parent.parent.parent / "worker" / "tests" / "golden"


def pairs_for(teams: list[str]) -> list[tuple[str, str]]:
    n = len(teams)
    idx = [0, 1, n // 4, n // 2, 3 * n // 4, n - 1]
    return [(teams[i], teams[j]) for i, j in zip(idx, reversed(idx), strict=True)]


def main() -> None:
    parser = argparse.ArgumentParser(description="Genera vectores golden de paridad.")
    parser.add_argument("--out", type=Path, default=GOLDEN_DIR)
    args = parser.parse_args()
    models.load()
    assert models.ft is not None and models.ft_ec1 is not None

    cases: list[dict] = []
    for home, away in pairs_for(list(models.ft.teams)):
        cases.append(
            {
                "home": home,
                "away": away,
                "league": "global",
                "expected": build_prediction(home, away, models.ft),
            }
        )
    for home, away in pairs_for(list(models.ft_ec1.teams)):
        cases.append(
            {
                "home": home,
                "away": away,
                "league": "EC1",
                "expected": build_prediction(home, away, models.ft_ec1),
            }
        )
    same = list(models.ft.teams)[10]
    cases.append(
        {
            "home": same,
            "away": same,
            "league": "global",
            "expected": build_prediction(same, same, models.ft),
        }
    )
    cases.append(
        {
            "home": "Equipo Inexistente ZZ",
            "away": list(models.ft.teams)[3],
            "league": "global",
            "expected": build_prediction(
                "Equipo Inexistente ZZ", list(models.ft.teams)[3], models.ft
            ),
        }
    )

    args.out.mkdir(parents=True, exist_ok=True)
    for i, case in enumerate(cases):
        (args.out / f"case_{i:02d}.json").write_text(
            json.dumps(case, ensure_ascii=False, separators=(",", ":")), encoding="utf-8"
        )
    total_kb = sum(p.stat().st_size for p in args.out.glob("*.json")) / 1024
    print(f"generados {len(cases)} golden en {args.out} ({total_kb:.1f} KB)")


if __name__ == "__main__":
    main()
