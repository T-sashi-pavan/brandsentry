export interface PermissionModule {
  enabled: boolean;
  actions: string[];
}

export type PermissionMap = Record<string, PermissionModule>;

export interface User {
  id: string;
  email: string;
  full_name: string;
  role: string;
  department?: string;
  is_active: boolean;
  is_superuser: boolean;
  created_at: string;
  // RBAC — see backend/app/core/permissions.py. custom_permissions is the
  // raw per-user override (undefined/null when inheriting role defaults);
  // effective_permissions is the fully-resolved map the backend computed
  // for this user (role defaults + overrides, or "everything" for Super
  // Admin) and is what AuthContext.hasPermission actually reads.
  custom_permissions?: PermissionMap | null;
  effective_permissions?: PermissionMap;
}

export interface AuthState {
  user: User | null;
  token: string | null;
  isAuthenticated: boolean;
}

export interface SimilarName {
  id: string;
  name: string;
  similarity_type: string;
  similarity_score: number;
  source: string;
  risk_level: 'LOW' | 'MEDIUM' | 'HIGH';
  therapeutic_area?: string;
  manufacturer?: string;
  country?: string;
}

export interface Conflict {
  id: string;
  conflicting_name: string;
  conflict_type: string;
  source: string;
  severity: 'LOW' | 'MEDIUM' | 'HIGH';
  similarity_score?: number;
  details?: string;
  registration_number?: string;
  owner?: string;
  status?: string;
}

export interface KnockoutCheckItem {
  id: string;
  label: string;
  rule: string;
  status: 'pass' | 'warn' | 'fail';
  detail?: string;
  isKnockout: boolean;
}

export interface ScreeningResult {
  id: string;
  brand_search_id?: string;
  brand_name?: string;
  overall_risk_score: number;
  risk_classification: 'LOW' | 'MEDIUM' | 'HIGH';
  exact_match_score: number;
  spelling_similarity_score: number;
  phonetic_similarity_score: number;
  semantic_similarity_score: number;
  lookalike_score: number;
  soundalike_score: number;
  trademark_conflict_score: number;
  market_presence_score: number;
  availability_score?: number;
  memorability_score?: number;
  pronunciation_score?: number;
  ai_assessment?: string;
  ai_recommendation?: string;
  total_conflicts: number;
  trademark_conflicts: number;
  market_conflicts: number;
  epharmacy_conflicts: number;
  stages_completed?: number;
  rejected_at_stage?: number | null;
  rejected_stage_name?: string | null;
  rejection_reason?: string | null;
  // Set only when IQVIA (Stage 2) did NOT reject but flagged the name for
  // User Review (e.g. commercial growth data blank/NULL for the closest
  // match) — see backend BrandScreeningService._iqvia_stage_conflict.
  iqvia_review_note?: string | null;
  knockout_checks?: KnockoutCheckItem[];
  case_context?: Record<string, any> | null;
  coining_principles_eval?: Array<{
    id: number;
    title: string;
    desc: string;
    score: number;
    rationale: string;
  }>;
  grades?: ParameterGrades;
  combination?: string;
  similar_names: SimilarName[];
  conflicts: Conflict[];
  created_at: string;
}

export interface BrandSearchResponse {
  id: string;
  brand_name: string;
  status: string;
  screening_result?: ScreeningResult;
  created_at: string;
}

export interface ScreeningRequest {
  brand_name: string;
  include_semantic?: boolean;
  case_id?: string;
  case_data?: Record<string, any>;
}

export interface CompareRequest {
  brand_name: string;
  case_id?: string;
  case_data?: Record<string, any>;
}


export type CompareSource = 'screening_history' | 'generator_history' | 'fresh_pipeline';

export interface CompareResult extends BrandSearchResponse {
  source: CompareSource;
}

export interface GenerateNamesRequest {
  molecule?: string;
  therapeutic_area?: string;
  ailment?: string;
  treatment?: string;
  emotion_connected?: string;
  outcome?: string;
  geography?: string;
  product_attributes?: string;
  naming_style?: string;
  description?: string;
  count?: number;
  id?: string;
  case_id?: string;
  suggestion_form?: StructuredSuggestionPayload;
  user_id?: string;
  user_email?: string;
}

export interface StructuredSuggestionPayload {
  product_information: {
    generic_name: string;
    dosage_form: string;
    dose: string;
    division: string;
    suggested_by: string;
    date: string;
  };
  medical_information: {
    ailment: string;
    segment: string;
    therapy: string;
    promoting_indications: string;
  };
  manufacturing_information: {
    manufacturer_location: string;
    mfd_type: string;
    in_license: string;
    mfg_for_others_yn: string;
    mfg_for_others: string;
    parent_brand_owner: string;
  };
  commercial_information: {
    marketer_name: string;
    seller_name: string;
    expected_launch_month: string;
    expected_sale: string;
  };
  regulatory_information: {
    dcgi_combination_approved: string;
    drug_schedule: string;
  };
  brand_information: {
    domestic_brand_names: string;
    international_brand_names: string;
    innovator_brands: string;
  };
  patent_information: {
    patent_validity: string;
    launch_after_expiry: string;
    launch_after_expiry_month: string;
    launch_during_validity: string;
    launch_during_validity_arrangement: string;
  };
  molecule_history_information: {
    inventor_name: string;
    patient_name: string;
    place_of_origin: string;
    other_historical_association: string;
  };
  naming_information?: {
    treatment?: string;
    emotion_connected?: string;
    naming_style?: string;
    product_benefit?: string;
    brand_coining_preferences?: string;
    description?: string;
  };
  description?: string;
}

export interface ConflictEvidence {
  name: string;
  source: string;
  owner?: string;
  similarity_type: string;
  similarity_score: number;
  phonetic_score: number;
  spelling_score: number;
}

export interface ParameterGradeItem {
  score: number;
  grade: 'A' | 'B' | 'C' | 'D';
}

export interface ParameterGrades {
  phonetic: ParameterGradeItem;
  spelling: ParameterGradeItem;
  conceptual: ParameterGradeItem;
  visual: ParameterGradeItem;
  combination: string;
  risk_classification: 'LOW' | 'MEDIUM' | 'HIGH';
}

export interface GradeRange {
  min: number;
  max: number;
}

export interface GradeThresholds {
  A: GradeRange;
  B: GradeRange;
  C: GradeRange;
  D: GradeRange;
}

export interface CombinationRule {
  phonetic: 'A' | 'B' | 'C' | 'D';
  spelling: 'A' | 'B' | 'C' | 'D';
  conceptual: 'A' | 'B' | 'C' | 'D';
  visual: 'A' | 'B' | 'C' | 'D';
  combination: string;
  risk_level: 'LOW' | 'MEDIUM' | 'HIGH';
  recommendation: 'PROCEED' | 'LEGAL_REVIEW' | 'REJECT';
}

export interface ConflictDetails {
  rationale: string;
  coining_principles?: string[];
  business_alignment?: string;
  top_conflicts: ConflictEvidence[];
  weights_used: RiskWeights;
  grades?: ParameterGrades;
  combination?: string;
  risk_classification?: 'LOW' | 'MEDIUM' | 'HIGH';
}

export interface GeneratedName {
  id: string;
  generated_name: string;
  molecule?: string;
  therapeutic_area?: string;
  coining_principles?: string[];
  business_alignment?: string;
  coining_preference_source?: string;
  naming_criteria_rationale?: string;
  clinical_rationale?: string;
  risk_score: number;
  availability_score: number;
  memorability_score: number;
  pronunciation_score: number;
  recommendation_status: 'recommended' | 'review_required' | 'high_risk';
  ai_explanation?: string;
  phonetic_analysis?: string;
  semantic_analysis?: string;
  trademark_availability?: string;
  conflict_details?: ConflictDetails;
  loop_approved?: number;
  rejected_before_count?: number;
  time_to_generate_seconds?: number;
  created_at: string;
}

export interface RiskWeights {
  phonetic: number;
  spelling: number;
  conceptual: number;
  visual: number;
}

export interface IntelligenceData {
  brand_name: string;
  trademark_presence: number;
  market_presence: number;
  epharmacy_presence: number;
  geographic_reach: number;
  competitor_count: number;
  market_saturation: number;
  brand_uniqueness_score: number;
  ai_summary?: string;
  similar_brands: SimilarName[];
  competitive_landscape: CompetitorEntry[];
  trend_data: TrendDataPoint[];
  similarity_breakdown: SimilarityBreakdown[];
  risk_distribution: RiskDistribution[];
}

export type BrandIntelligence = IntelligenceData;

export interface CompetitorEntry {
  brand: string;
  similarity_score: number;
  market_presence: number;
  trademark_status: string;
  manufacturer: string;
  therapeutic_area: string;
}

export interface TrendDataPoint {
  month: string;
  trademark: number;
  market: number;
  epharmacy: number;
}

export interface SimilarityBreakdown {
  type: string;
  count: number;
  color: string;
}

export interface RiskDistribution {
  level: string;
  count: number;
  color: string;
}

export interface AuditLog {
  id: string;
  user_id?: string;
  action: string;
  resource_type?: string;
  resource_id?: string;
  details?: string;
  log_metadata?: Record<string, unknown>;
  ip_address?: string;
  status: string;
  created_at: string;
  user_name?: string;
  user_email?: string;
}

export interface AuditLogListResponse {
  total: number;
  page: number;
  page_size: number;
  items: AuditLog[];
}

export type RiskLevel = 'LOW' | 'MEDIUM' | 'HIGH';
export type RecommendationStatus = 'recommended' | 'review_required' | 'high_risk';
export type LegalStatus = 'pending' | 'approved' | 'rejected' | 'needs_revision';

export interface ReviewMessage {
  id: string;
  review_id: string;
  sender_id?: string;
  sender_name: string;
  sender_role?: string;
  message: string;
  created_at: string;
}

export interface LegalReview {
  id: string;
  brand_name: string;
  proposed_by_name?: string;
  proposed_by_dept?: string;
  submitted_at: string;
  source_type: string;
  therapeutic_area?: string;
  target_market?: string;
  business_notes?: string;
  case_id?: string;
  case_name?: string;
  risk_score?: number;
  risk_level?: string;
  risk_ai_assessment?: string;
  market_ai_assessment?: string;
  status: LegalStatus;
  reviewer_name?: string;
  reviewed_at?: string;
  reviewer_comments?: string;
  legal_ref?: string;
  created_at: string;
  batch_id?: string;
  messages?: ReviewMessage[];
  messages_count?: number;
}

export type LegalBatchStatus = 'pending' | 'in_progress' | 'completed';

export interface LegalReviewBatch {
  id: string;
  batch_code: string;
  description?: string;
  proposed_by_name?: string;
  proposed_by_dept?: string;
  submitted_at: string;
  name_count: number;
  reviewed_count: number;
  approved_count: number;
  rejected_count: number;
  needs_revision_count: number;
  pending_count: number;
  status: LegalBatchStatus;
  names: string[];
}

export interface LegalReviewBatchDetail extends LegalReviewBatch {
  reviews: LegalReview[];
}

export interface SubmitBatchRequest {
  description?: string;
  items: SubmitReviewRequest[];
}

export type NotificationType =
  | 'legal_submitted'
  | 'legal_approved'
  | 'legal_rejected'
  | 'legal_needs_revision'
  | 'legal_retracted';

export interface Notification {
  id: string;
  type: NotificationType;
  title: string;
  message: string;
  resource_id: string | null;
  is_read: boolean;
  created_at: string;
}

export interface SubmitReviewRequest {
  brand_name: string;
  source_type?: string;
  brand_search_id?: string;
  generated_name_id?: string;
  therapeutic_area?: string;
  target_market?: string;
  business_notes?: string;
  risk_score?: number;
  risk_level?: string;
  risk_ai_assessment?: string;
  market_ai_assessment?: string;
}

export interface CartItem extends SubmitReviewRequest {
  id: string;
  case_id?: string;
  case_name?: string;
  added_at?: string;
}

export type DataSourceId = 'who_inn' | 'iqvia' | 'epharmacy' | 'google_search';

export interface DataSourceStatus {
  id: DataSourceId;
  name: string;
  category: string;
  description: string;
  enabled: boolean;
  connected: boolean;
  detail: string;
  status?: string;
  record_count?: number;
}

export interface IqviaRecord {
  id: string;
  brand_ims: string;
  normalized_name: string;
  molecules?: string | null;
  atc_iv?: string | null;
  company?: string | null;
  product_launch?: string | null;
  val_mat_current?: number | null;
  val_mat_prev?: number | null;
  val_gr_pct?: number | null;
  un_mat_current?: number | null;
  un_mat_prev?: number | null;
  un_gr_pct?: number | null;
  no_of_mol?: number | null;
  plain_comb?: string | null;
  is_active: boolean;
  as_of_date?: string | null;
  created_at?: string | null;
}

export interface IqviaPaginatedResponse {
  items: IqviaRecord[];
  total: number;
  page: number;
  page_size: number;
  total_pages: number;
}

export interface IqviaRecordCreatePayload {
  brand_ims: string;
  molecules?: string;
  atc_iv?: string;
  company?: string;
  product_launch?: string;
  val_mat_current?: number;
  val_mat_prev?: number;
  val_gr_pct?: number;
  un_mat_current?: number;
  un_mat_prev?: number;
  un_gr_pct?: number;
  no_of_mol?: number;
  plain_comb?: string;
  is_active?: boolean;
}

export interface IqviaRecordUpdatePayload {
  brand_ims?: string;
  molecules?: string;
  atc_iv?: string;
  company?: string;
  product_launch?: string;
  val_mat_current?: number;
  val_mat_prev?: number;
  val_gr_pct?: number;
  un_mat_current?: number;
  un_mat_prev?: number;
  un_gr_pct?: number;
  no_of_mol?: number;
  plain_comb?: string;
  is_active?: boolean;
}

// ── Dashboard Metrics ─────────────────────────────────────────────────────────

export interface SubCaseStatusDistribution {
  approved: number;
  rejected: number;
  revision_required: number;
  under_review: number;
  pending: number;
  total: number;
}

export interface DashboardKPI {
  total_cases: number;
  active_cases: number;
  closed_cases: number;
  total_generated_names: number;
  active_users?: number;
  active_sub_cases?: number;
  completed_reviews?: number;
  pending_review?: number;
  under_review?: number;
  revision_required?: number;
  submitted_for_tm_review?: number;
  avg_turnaround_days?: number;
  on_track_reviews?: number;
  delayed_reviews?: number;
}

export interface RecommendationDistribution {
  high: number;
  medium: number;
  low: number;
  total: number;
}

export interface AIRequestCounts {
  generation_requests: number;
  screening_requests: number;
}

export interface ReportDownloads {
  total: number;
  pdf: number;
  excel: number;
}

export interface TokenOperationBreakdown {
  name: string;
  badge: string;
  requests: number;
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
  share_pct: number;
  color: string;
}

export interface TokenConsumption {
  summary: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
  operations: TokenOperationBreakdown[];
  total: {
    requests: number;
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
    share_pct: number;
  };
}

export interface DashboardMetrics {
  kpi: DashboardKPI;
  sub_case_status_distribution?: SubCaseStatusDistribution;
  recommendation_distribution: RecommendationDistribution;
  ai_request_counts: AIRequestCounts;
  report_downloads: ReportDownloads;
  token_consumption: TokenConsumption;
}
