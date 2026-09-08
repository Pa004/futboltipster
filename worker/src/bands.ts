export interface Band {
  level: string;
  label: string;
  lo: number;
  hi: number;
}

// Fuente congelada: CONFIDENCE_BANDS de ml-service/app/models/dixon_coles.py.
// En Fase 1 no hay ml-service que consultar; Fase 2 la mantiene como constante.
export const DEFAULT_BANDS: Band[] = [
  { level: "seguro", label: "Seguro", lo: 0.65, hi: 1.01 },
  { level: "probable", label: "Probable", lo: 0.55, hi: 0.65 },
  { level: "ajustado", label: "Ajustado", lo: 0.45, hi: 0.55 },
  { level: "incierto", label: "Incierto", lo: 0, hi: 0.45 },
];
