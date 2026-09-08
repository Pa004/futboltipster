"""Exporta artefactos .npz a JSON para el Worker de Cloudflare.

El Worker no puede leer .npz; este script vuelca los parametros de inferencia
a worker/data/*.json con precision completa (sin redondeo: la paridad TS se
verifica con delta <1e-9). train.py y los .npz no se modifican.
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path

import numpy as np

ARTIFACT_DIR = Path(__file__).resolve().parent.parent / "artifacts"
WORKER_DATA_DIR = Path(__file__).resolve().parent.parent.parent / "worker" / "data"

DIXON_COLES_FILES = ("dixon_coles", "dixon_coles_ec1", "dixon_coles_ht")
COUNT_FILES = ("corners", "bookings", "shots_on_target", "fouls")


def _saved_at(data: np.lib.npyio.NpzFile) -> str:
    raw = data.get("saved_at")
    if raw is None:
        return ""
    return str(np.datetime64(raw[0]).astype("datetime64[s]"))


def export_dixon_coles(name: str) -> dict:
    with np.load(str(ARTIFACT_DIR / f"{name}.npz")) as data:
        return {
            "teams": [str(t) for t in data["teams"]],
            "attack": [float(v) for v in data["attack"]],
            "defense": [float(v) for v in data["defense"]],
            "mu": float(data["mu"][0]),
            "gamma": float(data["gamma"][0]),
            "rho": float(data["rho"][0]),
            "n_matches": int(data["n_matches"][0]),
            "saved_at": _saved_at(data),
        }


def export_count(name: str) -> dict:
    with np.load(str(ARTIFACT_DIR / f"{name}.npz")) as data:
        return {
            "teams": [str(t) for t in data["teams"]],
            "attack": [float(v) for v in data["attack"]],
            "defense": [float(v) for v in data["defense"]],
            "mu": float(data["mu"][0]),
            "gamma": float(data["gamma"][0]),
            "form": [float(v) for v in data["form"]],
            "form_beta": float(data["form_beta"][0]),
            "alpha_od": float(data["alpha_od"][0]),
            "n_matches": int(data["n_matches"][0]),
            "saved_at": _saved_at(data),
        }


def export_htft_cond() -> dict:
    with np.load(str(ARTIFACT_DIR / "htft_cond.npz")) as data:
        return {
            "cond": [[float(v) for v in row] for row in data["cond"]],
            "saved_at": _saved_at(data),
        }


def main() -> None:
    parser = argparse.ArgumentParser(description="Exporta .npz a JSON para el Worker.")
    parser.add_argument("--out", type=Path, default=WORKER_DATA_DIR)
    args = parser.parse_args()
    args.out.mkdir(parents=True, exist_ok=True)

    for name in DIXON_COLES_FILES:
        (args.out / f"{name}.json").write_text(
            json.dumps(export_dixon_coles(name)), encoding="utf-8"
        )
    for name in COUNT_FILES:
        (args.out / f"{name}.json").write_text(json.dumps(export_count(name)), encoding="utf-8")
    (args.out / "htft_cond.json").write_text(json.dumps(export_htft_cond()), encoding="utf-8")
    print(f"exportados {len(DIXON_COLES_FILES) + len(COUNT_FILES) + 1} JSON a {args.out}")


if __name__ == "__main__":
    main()
