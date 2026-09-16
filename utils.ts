import { type ClassValue, clsx } from 'clsx';
import { twMerge } from 'tailwind-merge';

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

export function getRiskColor(level: string): string {
  switch (level?.toUpperCase()) {
    case 'HIGH': return 'text-red-600';
    case 'MEDIUM': return 'text-orange-500';
    case 'LOW': return 'text-green-600';
    default: return 'text-gray-600';
  }
}

export function getRiskBgColor(level: string): string {
  switch (level?.toUpperCase()) {
    case 'HIGH': return 'bg-red-50 border-red-200 text-red-700';
    case 'MEDIUM': return 'bg-orange-50 border-orange-200 text-orange-700';
    case 'LOW': return 'bg-green-50 border-green-200 text-green-700';
    default: return 'bg-gray-50 border-gray-200 text-gray-700';
  }
}

export function getRiskBadgeVariant(level: string): 'destructive' | 'warning' | 'success' | 'default' {
  switch (level?.toUpperCase()) {
    case 'HIGH': return 'destructive';
    case 'MEDIUM': return 'warning';
    case 'LOW': return 'success';
    default: return 'default';
  }
}

export function getScoreColor(score: number): string {
  if (score >= 70) return 'text-red-600';
  if (score >= 40) return 'text-orange-500';
  return 'text-green-600';
}

// Keyed by the actual risk classification (LOW/MEDIUM/HIGH), not a separate
// numeric threshold on the raw score — a score can sit in HIGH's range by
// classification while still under a mismatched color threshold, which
// previously showed an orange gauge next to a "HIGH RISK" label.
export function getRiskLevelHexColor(level: string): string {
  switch (level?.toUpperCase()) {
    case 'HIGH': return '#EF4444';
    case 'MEDIUM': return '#F97316';
    default: return '#22C55E';
  }
}

export function formatScore(score: number, asPercent = false): string {
  if (asPercent) return `${(score * 100).toFixed(0)}%`;
  return score.toFixed(1);
}

export function formatDate(dateStr: string): string {
  // Backend stores naive UTC (datetime.utcnow()) and serializes it without a
  // timezone marker. Treat a tz-less string as UTC, then render in IST.
  const hasTz = /([zZ]|[+-]\d{2}:?\d{2})$/.test(dateStr);
  const date = new Date(hasTz ? dateStr : dateStr + 'Z');
  return date.toLocaleString('en-US', {
    timeZone: 'Asia/Kolkata',
    year: 'numeric', month: 'short', day: 'numeric',
    hour: '2-digit', minute: '2-digit',
  }) + ' (IST)';
}

export function getRecommendationColor(status: string): string {
  switch (status) {
    case 'recommended': return 'bg-green-100 text-green-700 border-green-200';
    case 'review_required': return 'bg-orange-100 text-orange-700 border-orange-200';
    case 'high_risk': return 'bg-red-100 text-red-700 border-red-200';
    default: return 'bg-gray-100 text-gray-700 border-gray-200';
  }
}

export function getRecommendationLabel(status: string): string {
  switch (status) {
    case 'recommended': return 'Recommended';
    case 'review_required': return 'Review Required';
    case 'high_risk': return 'High Risk';
    default: return status;
  }
}

export function getSourceBadgeStyle(source: string): string {
  const s = source?.toLowerCase() ?? '';
  if (s.includes('who inn') || s.includes('chembl')) return 'bg-sky-100 text-sky-700 border border-sky-200';
  if (s.includes('trademark')) return 'bg-purple-100 text-purple-700 border border-purple-200';
  if (s.includes('market database') || s === 'market database') return 'bg-green-100 text-green-700 border border-green-200';
  if (s.includes('e-pharmacy') || s.includes('epharmacy') || s.includes('pharmeasy') || s.includes('netmeds') || s.includes('1mg') || s.includes('apollo')) return 'bg-teal-100 text-teal-700 border border-teal-200';
  if (s.includes('fda drug') || s.includes('openfda')) return 'bg-orange-100 text-orange-700 border border-orange-200';
  if (s.includes('rxnorm')) return 'bg-blue-100 text-blue-700 border border-blue-200';
  if (s.includes('dailymed')) return 'bg-amber-100 text-amber-700 border border-amber-200';
  return 'bg-gray-100 text-gray-600 border border-gray-200';
}

export function formatSourceName(source?: string): string {
  if (!source) return '';
  const s = source
    .replace(/\s*\((?:chembl|ebi|ema)\)/gi, '')
    .replace(/\bchembl\b/gi, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!s || s.toLowerCase() === 'chembl') return 'WHO INN';
  return s;
}

export function cleanSimilarityType(type: string): string {
  if (!type) return 'Visual';
  if (type === 'Look-Alike' || type.toLowerCase().includes('look')) return 'Visual';
  if (type === 'Sound-Alike' || type.toLowerCase().includes('sound')) return 'Phonetic';
  return type;
}

export function getSimilarityTypeIcon(type: string): string {
  const clean = cleanSimilarityType(type);
  switch (clean) {
    case 'Exact Match': return '🎯';
    case 'Phonetic': return '🔊';
    case 'Visual': return '👁️';
    case 'Spelling': return '✏️';
    case 'Semantic':
    case 'Conceptual': return '🧠';
    default: return '🔍';
  }
}

