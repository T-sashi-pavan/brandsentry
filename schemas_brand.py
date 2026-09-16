import uuid
from datetime import datetime
from typing import Optional
from pydantic import BaseModel, Field


class ProductInformation(BaseModel):
    generic_name: str
    dosage_form: str = ""
    dose: str = ""
    division: str = ""
    suggested_by: str = ""
    date: str = ""


class MedicalInformation(BaseModel):
    ailment: str = ""
    segment: str = ""
    therapy: str = ""
    promoting_indications: str = ""


class ManufacturingInformation(BaseModel):
    manufacturer_location: str = ""
    mfd_type: str = ""
    in_license: str = ""
    mfg_for_others: str = ""
    parent_brand_owner: str = ""


class CommercialInformation(BaseModel):
    marketer_name: str = ""
    seller_name: str = ""
    expected_launch_month: str = ""
    expected_sale: str = ""


class RegulatoryInformation(BaseModel):
    dcgi_combination_approved: str = ""
    drug_schedule: str = ""


class BrandInformation(BaseModel):
    domestic_brand_names: str = ""
    international_brand_names: str = ""
    innovator_brands: str = ""


class PatentInformation(BaseModel):
    patent_validity: str = ""
    launch_after_expiry: str = ""
    launch_during_validity: str = ""


class NamingInformation(BaseModel):
    treatment: str = ""
    emotion_connected: str = ""
    naming_style: str = ""
    product_benefit: str = ""
    brand_coining_preferences: str = ""
    description: str = ""


class MoleculeHistoryInformation(BaseModel):
    inventor_name: str = ""
    patient_name: str = ""
    place_of_origin: str = ""
    other_historical_association: str = ""


class StructuredSuggestionPayload(BaseModel):
    product_information: ProductInformation
    medical_information: MedicalInformation
    manufacturing_information: ManufacturingInformation
    commercial_information: CommercialInformation
    regulatory_information: RegulatoryInformation
    brand_information: BrandInformation
    patent_information: PatentInformation
    # Previously missing from this schema entirely — Pydantic silently
    # stripped naming_information/molecule_history_information from every
    # /brands/generate call before generator.py ever saw them, so a linked
    # case's Naming Style selections and Additional Notes never reached the
    # LLM prompt. Optional so older cached frontend payloads without these
    # keys still validate.
    naming_information: Optional[NamingInformation] = None
    molecule_history_information: Optional[MoleculeHistoryInformation] = None


class GenerateNamesRequest(BaseModel):
    molecule: Optional[str] = None
    therapeutic_area: Optional[str] = None
    ailment: Optional[str] = None
    treatment: Optional[str] = None
    emotion_connected: Optional[str] = None
    outcome: Optional[str] = None
    geography: Optional[str] = None
    product_attributes: Optional[str] = None
    naming_style: Optional[str] = None
    description: Optional[str] = None
    count: int = Field(10, ge=1, le=20)

    # Present when generating from a saved Suggestion Form case.
    id: Optional[str] = None
    case_id: Optional[str] = Field(None, pattern=r"^[A-Za-z0-9_-]{1,30}$")
    suggestion_form: Optional[StructuredSuggestionPayload] = None

    # Accepted for parity with the frontend's payload but not trusted for
    # attribution — the authenticated user from the request's bearer token
    # is always used instead (see app/api/routes/brands.py).
    user_id: Optional[str] = None
    user_email: Optional[str] = None


class ConflictEvidenceSchema(BaseModel):
    name: str
    source: str
    owner: Optional[str] = None
    similarity_type: str
    similarity_score: float
    phonetic_score: float
    spelling_score: float


class ConflictDetailsSchema(BaseModel):
    rationale: str
    top_conflicts: list[ConflictEvidenceSchema] = []
    weights_used: dict


class GeneratedNameSchema(BaseModel):
    id: uuid.UUID
    generated_name: str
    molecule: Optional[str] = None
    therapeutic_area: Optional[str] = None
    risk_score: float
    availability_score: float
    memorability_score: float
    pronunciation_score: float
    recommendation_status: str
    ai_explanation: Optional[str] = None
    phonetic_analysis: Optional[str] = None
    semantic_analysis: Optional[str] = None
    trademark_availability: Optional[str] = None
    conflict_details: Optional[dict] = None
    created_at: datetime

    class Config:
        from_attributes = True
