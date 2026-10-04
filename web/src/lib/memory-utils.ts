export const CATEGORY_ORDER = [
  'identity',
  'relationships',
  'behavior',
  'preferences',
  'corrections',
  'knowledge',
  'unclassified',
] as const;

export type Classification = (typeof CATEGORY_ORDER)[number];

export const CLASSIFICATION_COLORS: Record<Classification, string> = {
  identity: '#a86828',
  relationships: '#c97e54',
  behavior: '#7a9e7e',
  preferences: '#c8a96a',
  corrections: '#b85c5c',
  knowledge: '#6b8caf',
  unclassified: '#8a8175',
};

export function classificationColor(value: string): string {
  if (value in CLASSIFICATION_COLORS) {
    return CLASSIFICATION_COLORS[value as Classification];
  }
  return CLASSIFICATION_COLORS.unclassified;
}

export function categoryLabel(value: string): string {
  return value
    .replace(/_/g, ' ')
    .replace(/\b\w/g, (char) => char.toUpperCase());
}

export function tierColor(tier: string): string {
  switch (tier) {
    case 'short_term':
      return 'var(--fg-muted)';
    case 'long_term':
      return 'var(--accent)';
    case 'lifelong':
      return 'var(--green)';
    default:
      return 'var(--fg-muted)';
  }
}

export function safeDate(value: string | null): string {
  if (!value) return '-';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString();
}

export const API_BASE =
  import.meta.env.VITE_API_BASE_URL ?? 'http://localhost:3005';

export function apiUrl(path: string): string {
  return `${API_BASE.replace(/\/$/, '')}${path.startsWith('/') ? path : `/${path}`}`;
}
