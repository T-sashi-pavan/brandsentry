import logging
from fastapi import APIRouter, Depends, HTTPException, Path, status
from sqlalchemy.orm import Session
from app.api.deps import get_current_user
from app.core.database import get_db
from app.models.user import User
from app.repositories.suggestion import SuggestionRepository
from app.schemas.suggestion import SuggestionCreateRequest, SuggestionFormOut

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/suggestions", tags=["Suggestions"])


def _to_out(form) -> SuggestionFormOut:
    return SuggestionFormOut(
        id=form.case_id,
        record_id=form.id,
        case_id=form.case_id,
        saved_at=form.created_at,
        generic_name=form.generic_name,
        division=form.division or "",
        dosage_form=form.dosage_form,
        suggested_by=form.suggested_by or "",
        dose=form.dose,
        date=form.date,
        ailment=form.ailment,
        segment=form.segment,
        therapy=form.therapy,
        promoting_indications=form.promoting_indications,
        manufacturer_location=form.manufacturer_location or "NA",
        mfd_type=form.mfd_type or "",
        in_license=form.in_license or "",
        mfg_for_others=form.mfg_for_others or "",
        parent_brand_owner=form.parent_brand_owner or "",
        marketer_name=form.marketer_name or "",
        seller_name=form.seller_name or "",
        expected_launch_month=form.expected_launch_month or "",
        expected_sale=form.expected_sale or "",
        dcgi_combination_approved=form.dcgi_combination_approved or "",
        drug_schedule=form.drug_schedule or "",
        domestic_brand_names=form.domestic_brand_names,
        international_brand_names=form.international_brand_names,
        innovator_brands=form.innovator_brands,
        patent_validity=form.patent_validity or "Patent Not in India",
        launch_after_expiry=form.launch_after_expiry or "No",
        launch_during_validity=form.launch_during_validity or "",
        description=getattr(form, "description", "") or "",
        naming_information=getattr(form, "naming_information", None),
        molecule_history_information=getattr(form, "molecule_history_information", None),
    )


@router.post("", response_model=SuggestionFormOut, status_code=status.HTTP_201_CREATED)
def create_suggestion(
    body: SuggestionCreateRequest,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    repo = SuggestionRepository(db)
    if body.id:
        existing = repo.get_by_case_id(body.id)
        if existing:
            logger.info("ℹ️ [INTAKE CASE] Reusing existing Case ID: %s (User: %s)", existing.case_id, current_user.email)
            return _to_out(existing)

    flattened = body.flatten()

    # Content-based duplicate check — a fresh submission (no body.id yet)
    # for the same Molecule + Division + Dosage Form as an already-saved
    # case is almost always the same real-world case being re-entered
    # (e.g. re-submitting the same "Fill Sample" data), not a genuinely new
    # one. Reject it with the existing case's id instead of silently piling
    # up duplicate rows that each re-trigger their own name generation.
    duplicate = repo.find_duplicate(
        flattened["generic_name"], flattened.get("division"), flattened["dosage_form"],
    )
    if duplicate:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail=(
                f"A case for \"{duplicate.generic_name}\""
                f"{f' ({duplicate.division})' if duplicate.division else ''} already exists "
                f"(Case ID: {duplicate.case_id}). Link that case instead of creating a new one."
            ),
        )

    form = repo.create(flattened, user_id=current_user.id)
    
    logger.info("================================================================================")
    logger.info("[NEW INTAKE CASE REGISTERED]: %s", form.case_id)
    logger.info("  * Molecule / Generic Name: %s", form.generic_name)
    logger.info("  * Dosage & Form:           %s (%s)", form.dose, form.dosage_form)
    logger.info("  * Division & Therapy:      %s | %s", form.division or "N/A", form.therapy)
    logger.info("  * Ailment / Indication:    %s", form.ailment)
    logger.info("  * Manufacturing & Owner:   %s (%s)", form.manufacturer_location, form.parent_brand_owner)
    logger.info("  * Competitor Reference:    Domestic: [%s] | Intl: [%s] | Innovator: [%s]",
                form.domestic_brand_names or "None", form.international_brand_names or "None", form.innovator_brands or "None")
    logger.info("  * Submitted By:            %s (%s)", form.suggested_by, current_user.email)
    logger.info("================================================================================")
    return _to_out(form)


@router.put("/{case_id}", response_model=SuggestionFormOut)
def update_suggestion(
    case_id: str,
    body: SuggestionCreateRequest,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    repo = SuggestionRepository(db)
    form = repo.get_by_case_id(case_id)
    if not form:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Case not found")
    if not current_user.is_superuser and form.user_id != current_user.id:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Not permitted to modify this case")
    
    flattened = body.flatten()
    updated = repo.update(case_id, flattened)
    if not updated:
        raise HTTPException(status_code=status.HTTP_500_INTERNAL_SERVER_ERROR, detail="Failed to update case")
    logger.info("Suggestion case updated: %s by %s", case_id, current_user.email)
    return _to_out(updated)


@router.get("", response_model=list[SuggestionFormOut])
def list_suggestions(
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    # All authenticated users can view and link existing cases in the workspace
    forms = SuggestionRepository(db).list_all()
    return [_to_out(f) for f in forms]


@router.get("/{case_id}", response_model=SuggestionFormOut)
def get_suggestion(
    case_id: str = Path(..., pattern=r"^[A-Za-z0-9_-]{1,30}$"),
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    form = SuggestionRepository(db).get_by_case_id(case_id)
    if not form:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Case not found")
    if not current_user.is_superuser and form.user_id != current_user.id:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Not permitted to view this case")
    return _to_out(form)


@router.delete("/{case_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_suggestion(
    case_id: str = Path(..., pattern=r"^[A-Za-z0-9_-]{1,30}$"),
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    repo = SuggestionRepository(db)
    form = repo.get_by_case_id(case_id)
    if not form:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Case not found")
    if not current_user.is_superuser and form.user_id != current_user.id:
        logger.warning("%s denied deleting case %s (not owner)", current_user.email, case_id)
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Not permitted to delete this case")
    repo.delete(case_id)
    logger.info("Suggestion case deleted: %s by %s", case_id, current_user.email)
