// Client-side cache of Brand Name Suggestion forms ("cases") that the
// backend has actually confirmed. Case IDs are the backend's responsibility
// to issue (per backend team feedback, 2026-08-12) — this store never
// fabricates one. A case only lands here once a real backend response
// returns an id (see saveConfirmedCase); everything else is a local draft
// with nothing to persist until that happens.

import type { StructuredSuggestionPayload } from '@/types';

export interface NamingCriteria {
  treatment: string;
  emotion_connected: string;
  naming_style: string;
  product_benefit: string;
  brand_coining_preferences: string;
  description?: string;
}

export const EMPTY_NAMING_CRITERIA: NamingCriteria = {
  treatment: '',
  emotion_connected: '',
  naming_style: '',
  product_benefit: '',
  brand_coining_preferences: '',
  description: '',
};

export const DEFAULT_NAMING_CRITERIA: NamingCriteria = {
  treatment: 'Targeted symptomatic relief with high safety margin and fast onset of action',
  emotion_connected: 'Trust, modern efficacy, professional confidence and therapeutic vitality',
  naming_style: 'Modern Scientific & Distinctive Pharmaceutical',
  product_benefit: 'Rapid relief, sustained therapeutic protection and superior patient compliance',
  brand_coining_preferences: 'Short, memorable, 2-3 syllables, distinctive vowel cadence',
  description: '',
};

export interface SuggestionForm {
  generic_name: string;
  division: string;
  dosage_form: string;
  suggested_by: string;
  dose: string;
  date: string;
  ailment: string;
  segment: string;
  therapy: string;
  promoting_indications: string;
  mfd_type: string;
  in_license: string;
  manufacturer_location: string;
  // Split per BRD mentor validation spec: a Yes/No selector plus the
  // conditional free-text "marks of such others" (required only when Yes).
  mfg_for_others_yn: string;
  mfg_for_others: string;
  marketer_name: string;
  seller_name: string;
  parent_brand_owner: string;
  expected_launch_month: string;
  expected_sale: string;
  dcgi_combination_approved: string;
  drug_schedule: string;
  domestic_brand_names: string;
  international_brand_names: string;
  innovator_brands: string;
  patent_validity: string;
  // Yes/No selector ("launching after expiry of patent?") plus the
  // conditional Month/Year value, required only when Yes.
  launch_after_expiry: string;
  launch_after_expiry_month: string;
  // Yes/No selector ("launching during validity of patent?") plus the
  // conditional arrangement free text, required only when Yes.
  launch_during_validity: string;
  launch_during_validity_arrangement: string;
  // Molecule / Product History — all optional, per the mentor's validation
  // spec; not yet persisted server-side (see buildStructuredPayload note).
  inventor_name: string;
  patient_name: string;
  place_of_origin: string;
  other_historical_association: string;
  description?: string;
  naming_information?: NamingCriteria;
}

export interface BrandCase extends SuggestionForm {
  id: string;
  case_id: string;
  saved_at: string;
  can_edit?: boolean;
}

const STORAGE_KEY = 'pharma_brand_suggestions';

// Raw read — no filtering. Used internally so a re-save of the same
// backend case_id overwrites its old entry instead of duplicating it.
function readAll(): BrandCase[] {
  try {
    const raw = JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]');
    return Array.isArray(raw) ? raw.filter((c) => c && c.case_id) : [];
  } catch {
    return [];
  }
}

// Public listing for the case selector — every entry here has a real
// backend-issued case_id (there is no other kind anymore).
export function listCases(): BrandCase[] {
  return readAll();
}

// Case Name per the BRD (Section 5.2.2.1): "<Molecule Name> + <Division>" —
// not the molecule/generic name alone. Division is an optional field, so
// falls back to just the molecule name when it isn't set (nothing to
// combine with). Used everywhere a case is shown or tagged by name; NOT
// used for the molecule form field itself (e.g. prefilling AI Generator's
// "Molecule" input on Link a Case), which is deliberately generic_name alone.
export function caseDisplayName(c?: Pick<BrandCase, 'generic_name' | 'division' | 'case_id'> | null): string {
  if (!c) return '';
  const name = c.generic_name?.trim();
  const division = c.division?.trim();
  if (name && division) return `${name} - ${division}`;
  return name || c.case_id || '';
}

export function getCase(caseId: string): BrandCase | undefined {
  return readAll().find((c) => c.case_id === caseId);
}

// Writes/overwrites one case in the local cache, keyed by case_id — shared
// by saveConfirmedCase (a case just created here) and cacheFromBackend (a
// case fetched from GET /suggestions, selected via CaseSelector) so every
// consumer that reads synchronously via getCase()/listCases() sees it,
// without needing to refetch from the backend on every lookup.
function cacheCase(record: BrandCase): void {
  const existing = readAll().filter((c) => c.case_id !== record.case_id);
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify([record, ...existing].slice(0, 200)));
  } catch {
    /* storage unavailable — non-fatal */
  }
}

// Persist a case using the id the backend just returned. Call this only
// after a successful backend response — never speculatively.
export function saveConfirmedCase(form: SuggestionForm, caseId: string, naming?: NamingCriteria): BrandCase {
  const record: BrandCase = {
    ...form,
    id: caseId,
    case_id: caseId,
    saved_at: form.date ? (form.date.includes('T') ? form.date : `${form.date}T00:00:00.000Z`) : new Date().toISOString(),
    naming_information: naming || form.naming_information,
    description: naming?.description || form.description || '',
    can_edit: true,
  };
  cacheCase(record);
  return record;
}

// Maps GET /suggestions's response shape (SuggestionFormOut — see
// backend/app/api/routes/suggestion.py) into the frontend's BrandCase shape,
// and caches it locally so getCase()/listCases() (used by pages that haven't
// been converted to fetch from the backend directly) stay in sync.
export function cacheFromBackend(s: Record<string, unknown>): BrandCase {
  const str = (v: unknown) => (typeof v === 'string' ? v : '');
  const namingRaw = (s.naming_information as Record<string, string>) || {};
  const moleculeHistoryRaw = (s.molecule_history_information as Record<string, string>) || {};
  const naming: NamingCriteria | undefined = s.naming_information ? {
    treatment: str(namingRaw.treatment),
    emotion_connected: str(namingRaw.emotion_connected),
    naming_style: str(namingRaw.naming_style),
    product_benefit: str(namingRaw.product_benefit),
    brand_coining_preferences: str(namingRaw.brand_coining_preferences),
    description: str(namingRaw.description || s.description),
  } : undefined;

  const record: BrandCase = {
    id: str(s.record_id) || str(s.case_id),
    case_id: str(s.case_id),
    saved_at: str(s.saved_at) || str(s.created_at) || str(s.date) || new Date().toISOString(),
    generic_name: str(s.generic_name),
    division: str(s.division),
    dosage_form: str(s.dosage_form),
    suggested_by: str(s.suggested_by),
    dose: str(s.dose),
    date: str(s.date),
    ailment: str(s.ailment),
    segment: str(s.segment),
    therapy: str(s.therapy),
    promoting_indications: str(s.promoting_indications),
    manufacturer_location: str(s.manufacturer_location),
    mfd_type: str(s.mfd_type),
    in_license: str(s.in_license),
    mfg_for_others_yn: '',
    mfg_for_others: str(s.mfg_for_others),
    marketer_name: str(s.marketer_name),
    seller_name: str(s.seller_name),
    parent_brand_owner: str(s.parent_brand_owner),
    expected_launch_month: str(s.expected_launch_month),
    expected_sale: str(s.expected_sale),
    dcgi_combination_approved: str(s.dcgi_combination_approved),
    drug_schedule: str(s.drug_schedule),
    domestic_brand_names: str(s.domestic_brand_names),
    international_brand_names: str(s.international_brand_names),
    innovator_brands: str(s.innovator_brands),
    patent_validity: str(s.patent_validity),
    launch_after_expiry: str(s.launch_after_expiry),
    launch_after_expiry_month: '',
    launch_during_validity: str(s.launch_during_validity),
    launch_during_validity_arrangement: '',
    inventor_name: str(moleculeHistoryRaw.inventor_name),
    patient_name: str(moleculeHistoryRaw.patient_name),
    place_of_origin: str(moleculeHistoryRaw.place_of_origin),
    other_historical_association: str(moleculeHistoryRaw.other_historical_association),
    description: str(s.description),
    naming_information: naming,
    can_edit: true,
  };
  cacheCase(record);
  return record;
}

// Groups a flat Suggestion Form (or saved case) into the structured JSON shape
// the AI Generator's "Generate Names" call sends alongside its own flat
// fields — every field the user entered on the intake form, nested by
// section, so no data captured on the form is lost when generating names.
export function buildStructuredPayload(form: SuggestionForm, naming?: NamingCriteria): StructuredSuggestionPayload {
  const ni = naming || form.naming_information;
  return {
    product_information: {
      generic_name: form.generic_name,
      dosage_form: form.dosage_form,
      dose: form.dose,
      division: form.division,
      suggested_by: form.suggested_by,
      date: form.date,
    },
    medical_information: {
      ailment: form.ailment,
      segment: form.segment,
      therapy: form.therapy,
      promoting_indications: form.promoting_indications,
    },
    manufacturing_information: {
      manufacturer_location: form.manufacturer_location,
      mfd_type: form.mfd_type,
      in_license: form.in_license,
      mfg_for_others_yn: form.mfg_for_others_yn,
      mfg_for_others: form.mfg_for_others,
      parent_brand_owner: form.parent_brand_owner,
    },
    commercial_information: {
      marketer_name: form.marketer_name,
      seller_name: form.seller_name,
      expected_launch_month: form.expected_launch_month,
      expected_sale: form.expected_sale,
    },
    regulatory_information: {
      dcgi_combination_approved: form.dcgi_combination_approved,
      drug_schedule: form.drug_schedule,
    },
    brand_information: {
      domestic_brand_names: form.domestic_brand_names,
      international_brand_names: form.international_brand_names,
      innovator_brands: form.innovator_brands,
    },
    patent_information: {
      patent_validity: form.patent_validity,
      launch_after_expiry: form.launch_after_expiry,
      launch_after_expiry_month: form.launch_after_expiry_month,
      launch_during_validity: form.launch_during_validity,
      launch_during_validity_arrangement: form.launch_during_validity_arrangement,
    },
    molecule_history_information: {
      inventor_name: form.inventor_name,
      patient_name: form.patient_name,
      place_of_origin: form.place_of_origin,
      other_historical_association: form.other_historical_association,
    },
    naming_information: ni ? {
      treatment: ni.treatment,
      emotion_connected: ni.emotion_connected,
      naming_style: ni.naming_style,
      product_benefit: ni.product_benefit,
      brand_coining_preferences: ni.brand_coining_preferences,
      description: ni.description || form.description || '',
    } : undefined,
    description: ni?.description || form.description || '',
  };
}
