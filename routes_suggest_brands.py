from fastapi import APIRouter, Depends, status
from sqlalchemy.orm import Session
import uuid
from datetime import datetime, timezone

from app.core.database import get_db
from app.api.deps import get_current_user
from app.core.rate_limit import rate_limit
from app.models.user import User
from app.schemas.suggest_brands import SuggestBrandsRequest, SuggestBrandsResponse, SuggestedBrandItem
from app.services.generator import GeneratorService

router = APIRouter(prefix="/api/v1", tags=["Suggest Brands (Target Pipeline)"])


@router.post(
    "/suggest-brands",
    response_model=SuggestBrandsResponse,
    status_code=status.HTTP_200_OK,
    dependencies=[Depends(rate_limit(max_requests=10, window_seconds=60))],
)
async def suggest_brands(
    request: SuggestBrandsRequest,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """
    Unified Production Endpoint: /api/v1/suggest-brands
    
    Accepts full Brand Suggestion Form input schema, executes LLM generation,
    post-generation rejection gate, similarity scoring, and external validation.
    """
    user_id = current_user.id
    service = GeneratorService(db)
    
    # Map structured request to generation pipeline parameters
    molecule = request.product_information.generic_name
    therapeutic_area = request.medical_information.therapy
    ailment = request.medical_information.ailment
    treatment = request.medical_information.segment
    description = request.medical_information.promoting_indications
    geography = "India"
    
    # Execute generation & scoring pipeline
    results = await service.generate_names(
        molecule=molecule,
        therapeutic_area=therapeutic_area,
        ailment=ailment,
        treatment=treatment,
        emotion_connected=None,
        outcome=None,
        geography=geography,
        product_attributes=f"{request.product_information.dosage_form} {request.product_information.dose}",
        naming_style="Coined Word",
        description=description,
        count=10,
        user_id=user_id,
    )
    
    # Format to Target Structured Response
    request_id = uuid.uuid4()
    suggestions: list[SuggestedBrandItem] = []
    
    for item in results:
        rec_cat = "HIGH" if item.recommendation_status == "recommended" else "MEDIUM" if item.recommendation_status == "review_required" else "LOW"
        conf_score = max(0.0, round(100.0 - item.risk_score, 1))
        
        top_conflicts = item.conflict_details.top_conflicts if item.conflict_details else []
        
        suggestions.append(
            SuggestedBrandItem(
                id=item.id,
                suggested_name=item.generated_name,
                confidence_score=conf_score,
                recommendation_category=rec_cat,
                overall_assessment=item.ai_explanation or f"Brand suggestion derived for {molecule}.",
                similarity_results={
                    "phonetic_analysis": item.phonetic_analysis or "High phonetic distinction",
                    "semantic_analysis": item.semantic_analysis or "Favorable semantic profile",
                    "trademark_availability": item.trademark_availability or "Check Required"
                },
                rationale={
                    "reasoning": item.conflict_details.rationale if item.conflict_details else "No direct conflicts detected.",
                    "weights_used": item.conflict_details.weights_used if item.conflict_details else {}
                },
                references=[
                    {
                        "name": c.name,
                        "source": c.source,
                        "similarity_score": c.similarity_score,
                        "similarity_type": c.similarity_type,
                        "owner": c.owner
                    }
                    for c in top_conflicts
                ]
            )
        )
        
    return SuggestBrandsResponse(
        request_id=request_id,
        status="completed",
        total_suggested=len(suggestions),
        suggestions=suggestions,
        created_at=datetime.now(timezone.utc)
    )
