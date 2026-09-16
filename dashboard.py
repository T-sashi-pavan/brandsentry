"""
Dashboard metrics and analytics endpoint.
Aggregates live data from brand_suggestion_forms, generated_brand_names,
brand_searches, screening_results, legal_reviews, users, and audit_logs.
"""

from fastapi import APIRouter, Depends, Query, HTTPException, status
from sqlalchemy.orm import Session
from sqlalchemy import func, distinct, or_
from typing import Optional
from datetime import datetime, timedelta, timezone
import uuid

from app.core.database import get_db
from app.api.deps import get_current_user
from app.models.user import User
from app.models.suggestion import BrandSuggestionForm
from app.models.brand import GeneratedBrandName
from app.models.screening import BrandSearch
from app.models.legal import LegalReview
from app.models.audit import AuditLog

router = APIRouter(prefix="/dashboard", tags=["Dashboard"])


def parse_date_filter(val: Optional[str], is_end_of_day: bool = False) -> Optional[datetime]:
    if not val or not isinstance(val, str) or not val.strip():
        return None
    val = val.strip()
    try:
        # Handle ISO strings with Z or timezone offset (e.g. 2026-09-07T18:29:59.999Z or +05:30)
        if "T" in val:
            dt = datetime.fromisoformat(val.replace("Z", "+00:00"))
            if dt.tzinfo is not None:
                # Convert to UTC naive datetime to match database UTC DateTime columns
                dt = dt.astimezone(timezone.utc).replace(tzinfo=None)
            elif is_end_of_day and dt.hour == 0 and dt.minute == 0 and dt.second == 0:
                dt = dt.replace(hour=23, minute=59, second=59, microsecond=999999)
            return dt
        # Handle plain date string "YYYY-MM-DD"
        if len(val) == 10 and val.count("-") == 2:
            if is_end_of_day:
                return datetime.fromisoformat(f"{val}T23:59:59.999999")
            else:
                return datetime.fromisoformat(f"{val}T00:00:00")
        dt = datetime.fromisoformat(val)
        if dt.tzinfo is not None:
            dt = dt.astimezone(timezone.utc).replace(tzinfo=None)
        elif is_end_of_day and dt.hour == 0 and dt.minute == 0 and dt.second == 0:
            dt = dt.replace(hour=23, minute=59, second=59, microsecond=999999)
        return dt
    except Exception:
        return None


@router.get("/metrics")
def get_dashboard_metrics(
    date_from: Optional[str] = Query(None),
    date_to: Optional[str] = Query(None),
    user_id: Optional[str] = Query(None),
    case_name: Optional[str] = Query(None),
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    # Parse date filters with full day and timezone support
    dt_from = parse_date_filter(date_from, is_end_of_day=False)
    dt_to = parse_date_filter(date_to, is_end_of_day=True)

    now_utc = datetime.now(timezone.utc).replace(tzinfo=None)
    today_margin = (now_utc + timedelta(days=1)).date()

    if dt_from and dt_from.date() > today_margin:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="From Date cannot be in the future",
        )
    if dt_to and dt_to.date() > today_margin:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="To Date cannot be in the future",
        )
    if dt_from and dt_to and dt_from > dt_to:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="From Date cannot be later than To Date",
        )

    # Parse user filter (applies only when a specific user is explicitly selected in the UI filter)
    target_user_id = None
    if user_id and user_id != "all":
        try:
            target_user_id = uuid.UUID(user_id)
        except ValueError:
            pass

    # Only admins/super_admins may view another user's or platform-wide KPIs.
    # A non-admin's effective filter is always forced to their own user id,
    # regardless of what was passed in the user_id query param.
    is_admin = current_user.is_superuser or current_user.role in ("admin", "super_admin")
    if not is_admin:
        target_user_id = current_user.id

    # 1. Total Cases Calculation from DB
    q_cases = db.query(BrandSuggestionForm)
    if target_user_id:
        q_cases = q_cases.filter(BrandSuggestionForm.user_id == target_user_id)
    if dt_from:
        q_cases = q_cases.filter(BrandSuggestionForm.created_at >= dt_from)
    if dt_to:
        q_cases = q_cases.filter(BrandSuggestionForm.created_at <= dt_to)
    if case_name and case_name != "all":
        q_cases = q_cases.filter(
            or_(
                BrandSuggestionForm.case_id.ilike(f"%{case_name}%"),
                BrandSuggestionForm.generic_name.ilike(f"%{case_name}%"),
                BrandSuggestionForm.ailment.ilike(f"%{case_name}%"),
            )
        )
    cases_count = q_cases.count()

    q_gen_cases = db.query(distinct(GeneratedBrandName.case_id)).filter(GeneratedBrandName.case_id.isnot(None))
    if target_user_id:
        q_gen_cases = q_gen_cases.filter(GeneratedBrandName.user_id == target_user_id)
    if dt_from:
        q_gen_cases = q_gen_cases.filter(GeneratedBrandName.created_at >= dt_from)
    if dt_to:
        q_gen_cases = q_gen_cases.filter(GeneratedBrandName.created_at <= dt_to)
    gen_cases = {row[0] for row in q_gen_cases.all() if row[0]}

    total_cases = max(cases_count, len(gen_cases))

    # Active vs Closed cases
    thirty_days_ago = datetime.now(timezone.utc) - timedelta(days=30)
    q_active_gen = db.query(distinct(GeneratedBrandName.case_id)).filter(
        GeneratedBrandName.case_id.isnot(None),
        GeneratedBrandName.created_at >= thirty_days_ago,
    )
    if target_user_id:
        q_active_gen = q_active_gen.filter(GeneratedBrandName.user_id == target_user_id)
    active_case_ids = {row[0] for row in q_active_gen.all() if row[0]}

    q_pending_reviews = db.query(distinct(LegalReview.case_id)).filter(
        LegalReview.status.in_(["pending", "under_review", "revision_required"]),
        LegalReview.case_id.isnot(None),
    )
    for row in q_pending_reviews.all():
        if row[0]:
            active_case_ids.add(row[0])

    active_cases = min(len(active_case_ids), total_cases)
    closed_cases = max(0, total_cases - active_cases)

    # 2. Total Generated Names (Counting unique/distinct brand names to avoid duplicate bloat)
    q_gen = db.query(distinct(func.lower(GeneratedBrandName.generated_name)))
    if target_user_id:
        q_gen = q_gen.filter(GeneratedBrandName.user_id == target_user_id)
    if dt_from:
        q_gen = q_gen.filter(GeneratedBrandName.created_at >= dt_from)
    if dt_to:
        q_gen = q_gen.filter(GeneratedBrandName.created_at <= dt_to)
    if case_name and case_name != "all":
        q_gen = q_gen.filter(GeneratedBrandName.case_id.ilike(f"%{case_name}%"))
    total_generated_names = q_gen.count()

    # 3. Active Users Count from DB (properly filtered if date range or specific user is selected)
    if dt_from or dt_to:
        active_user_ids = set()

        q_audit_users = db.query(distinct(AuditLog.user_id)).filter(AuditLog.user_id.isnot(None))
        q_case_users = db.query(distinct(BrandSuggestionForm.user_id)).filter(BrandSuggestionForm.user_id.isnot(None))
        q_gen_users = db.query(distinct(GeneratedBrandName.user_id)).filter(GeneratedBrandName.user_id.isnot(None))
        q_search_users = db.query(distinct(BrandSearch.user_id)).filter(BrandSearch.user_id.isnot(None))
        q_legal_proposers = db.query(distinct(LegalReview.proposed_by_id)).filter(LegalReview.proposed_by_id.isnot(None))
        q_legal_reviewers = db.query(distinct(LegalReview.reviewer_id)).filter(LegalReview.reviewer_id.isnot(None))
        q_created_users = db.query(distinct(User.id)).filter(User.is_active == True)

        if target_user_id:
            q_audit_users = q_audit_users.filter(AuditLog.user_id == target_user_id)
            q_case_users = q_case_users.filter(BrandSuggestionForm.user_id == target_user_id)
            q_gen_users = q_gen_users.filter(GeneratedBrandName.user_id == target_user_id)
            q_search_users = q_search_users.filter(BrandSearch.user_id == target_user_id)
            q_legal_proposers = q_legal_proposers.filter(LegalReview.proposed_by_id == target_user_id)
            q_legal_reviewers = q_legal_reviewers.filter(LegalReview.reviewer_id == target_user_id)
            q_created_users = q_created_users.filter(User.id == target_user_id)

        if dt_from:
            q_audit_users = q_audit_users.filter(AuditLog.created_at >= dt_from)
            q_case_users = q_case_users.filter(BrandSuggestionForm.created_at >= dt_from)
            q_gen_users = q_gen_users.filter(GeneratedBrandName.created_at >= dt_from)
            q_search_users = q_search_users.filter(BrandSearch.created_at >= dt_from)
            q_legal_proposers = q_legal_proposers.filter(LegalReview.created_at >= dt_from)
            q_legal_reviewers = q_legal_reviewers.filter(LegalReview.created_at >= dt_from)
            q_created_users = q_created_users.filter(User.created_at >= dt_from)

        if dt_to:
            q_audit_users = q_audit_users.filter(AuditLog.created_at <= dt_to)
            q_case_users = q_case_users.filter(BrandSuggestionForm.created_at <= dt_to)
            q_gen_users = q_gen_users.filter(GeneratedBrandName.created_at <= dt_to)
            q_search_users = q_search_users.filter(BrandSearch.created_at <= dt_to)
            q_legal_proposers = q_legal_proposers.filter(LegalReview.created_at <= dt_to)
            q_legal_reviewers = q_legal_reviewers.filter(LegalReview.created_at <= dt_to)
            q_created_users = q_created_users.filter(User.created_at <= dt_to)

        for row in q_audit_users.all():
            if row[0]:
                active_user_ids.add(row[0])
        for row in q_case_users.all():
            if row[0]:
                active_user_ids.add(row[0])
        for row in q_gen_users.all():
            if row[0]:
                active_user_ids.add(row[0])
        for row in q_search_users.all():
            if row[0]:
                active_user_ids.add(row[0])
        for row in q_legal_proposers.all():
            if row[0]:
                active_user_ids.add(row[0])
        for row in q_legal_reviewers.all():
            if row[0]:
                active_user_ids.add(row[0])
        for row in q_created_users.all():
            if row[0]:
                active_user_ids.add(row[0])

        active_users_count = len(active_user_ids)
    else:
        q_users = db.query(User).filter(User.is_active == True)
        if target_user_id:
            q_users = q_users.filter(User.id == target_user_id)
        active_users_count = q_users.count()

    # 4. Legal Reviews / Sub-cases status counts from DB
    q_legal = db.query(LegalReview)
    if target_user_id:
        q_legal = q_legal.filter(or_(LegalReview.proposed_by_id == target_user_id, LegalReview.reviewer_id == target_user_id))
    if case_name and case_name != "all":
        q_legal = q_legal.filter(LegalReview.case_id.ilike(f"%{case_name}%"))
    if dt_from:
        q_legal = q_legal.filter(LegalReview.created_at >= dt_from)
    if dt_to:
        q_legal = q_legal.filter(LegalReview.created_at <= dt_to)

    approved_reviews = q_legal.filter(LegalReview.status == "approved").count()
    rejected_reviews = q_legal.filter(LegalReview.status == "rejected").count()
    revision_reviews = q_legal.filter(LegalReview.status.in_(["needs_revision", "revision_required"])).count()
    under_review_count = q_legal.filter(LegalReview.status == "under_review").count()
    pending_review_count = q_legal.filter(LegalReview.status == "pending").count()
    active_sub_cases = pending_review_count + under_review_count + revision_reviews
    completed_reviews = approved_reviews + rejected_reviews

    # Real Average Turnaround Time & Case Aging Calculation from live review timestamps
    reviewed_items = q_legal.filter(LegalReview.reviewed_at.isnot(None), LegalReview.submitted_at.isnot(None)).all()
    if reviewed_items:
        turnarounds = [(r.reviewed_at - r.submitted_at).total_seconds() / 86400 for r in reviewed_items if r.reviewed_at >= r.submitted_at]
        avg_turnaround_days = round(max(0.1, sum(turnarounds) / len(turnarounds)), 1) if turnarounds else 0.0
    else:
        avg_turnaround_days = 0.0

    now_utc = datetime.now(timezone.utc)
    pending_items = q_legal.filter(LegalReview.status.in_(["pending", "under_review", "needs_revision", "revision_required"])).all()
    on_track_count = 0
    delayed_count = 0
    for p in pending_items:
        sub_time = p.submitted_at or p.created_at
        if sub_time:
            if sub_time.tzinfo is None:
                sub_time = sub_time.replace(tzinfo=timezone.utc)
            age_days = (now_utc - sub_time).total_seconds() / 86400
            if age_days > 10:
                delayed_count += 1
            else:
                on_track_count += 1
        else:
            on_track_count += 1

    # 5. Recommendation Distribution (Risk Breakdown of Generated Brand Names)
    high_count = q_gen.filter(GeneratedBrandName.risk_score >= 60.0).count()
    med_count = q_gen.filter(GeneratedBrandName.risk_score >= 30.0, GeneratedBrandName.risk_score < 60.0).count()
    low_count = q_gen.filter(GeneratedBrandName.risk_score < 30.0).count()

    total_high = high_count
    total_med = med_count
    total_low = low_count
    total_recommendations = total_high + total_med + total_low

    # 6. AI Request Counts
    gen_name_count = q_gen.count()
    generation_requests = max(1, gen_name_count // 5) if gen_name_count > 0 else 0

    q_searches = db.query(BrandSearch)
    if target_user_id:
        q_searches = q_searches.filter(BrandSearch.user_id == target_user_id)
    if dt_from:
        q_searches = q_searches.filter(BrandSearch.created_at >= dt_from)
    if dt_to:
        q_searches = q_searches.filter(BrandSearch.created_at <= dt_to)
    screening_requests = q_searches.count()

    # 7. Report Downloads (Audit log action = 'EXPORT')
    q_exports = db.query(AuditLog).filter(AuditLog.action == "EXPORT")
    if target_user_id:
        q_exports = q_exports.filter(AuditLog.user_id == target_user_id)
    if dt_from:
        q_exports = q_exports.filter(AuditLog.created_at >= dt_from)
    if dt_to:
        q_exports = q_exports.filter(AuditLog.created_at <= dt_to)
    
    export_logs = q_exports.all()
    total_reports = len(export_logs)
    excel_reports = 0
    pdf_reports = 0
    for log in export_logs:
        meta = log.log_metadata or {}
        fmt = meta.get("format", "").upper() if isinstance(meta, dict) else ""
        if "EXCEL" in fmt or "XLS" in fmt:
            excel_reports += 1
        else:
            pdf_reports += 1

    # 8. AI Token Consumption Breakdown (L-29: real Bedrock usage from
    # TokenUsage, replacing the previous hardcoded multiplier/floor estimate)
    gen_reqs = generation_requests
    screen_reqs = screening_requests

    from app.models.token_usage import TokenUsage
    gen_usage_query = db.query(
        func.coalesce(func.sum(TokenUsage.prompt_tokens), 0),
        func.coalesce(func.sum(TokenUsage.completion_tokens), 0),
    ).filter(TokenUsage.feature_name.ilike("%Generation%"))
    screen_usage_query = db.query(
        func.coalesce(func.sum(TokenUsage.prompt_tokens), 0),
        func.coalesce(func.sum(TokenUsage.completion_tokens), 0),
    ).filter(TokenUsage.feature_name.ilike("%Screening%"))
    if target_user_id:
        gen_usage_query = gen_usage_query.filter(TokenUsage.user_id == target_user_id)
        screen_usage_query = screen_usage_query.filter(TokenUsage.user_id == target_user_id)
    if dt_from:
        gen_usage_query = gen_usage_query.filter(TokenUsage.created_at >= dt_from)
        screen_usage_query = screen_usage_query.filter(TokenUsage.created_at >= dt_from)
    if dt_to:
        gen_usage_query = gen_usage_query.filter(TokenUsage.created_at <= dt_to)
        screen_usage_query = screen_usage_query.filter(TokenUsage.created_at <= dt_to)

    gen_prompt_tokens, gen_comp_tokens = gen_usage_query.first()
    gen_prompt_tokens, gen_comp_tokens = int(gen_prompt_tokens), int(gen_comp_tokens)
    gen_total_tokens = gen_prompt_tokens + gen_comp_tokens

    screen_prompt_tokens, screen_comp_tokens = screen_usage_query.first()
    screen_prompt_tokens, screen_comp_tokens = int(screen_prompt_tokens), int(screen_comp_tokens)
    screen_total_tokens = screen_prompt_tokens + screen_comp_tokens

    all_total_tokens = gen_total_tokens + screen_total_tokens
    all_prompt_tokens = gen_prompt_tokens + screen_prompt_tokens
    all_comp_tokens = gen_comp_tokens + screen_comp_tokens

    if all_total_tokens > 0:
        gen_share_pct = round((gen_total_tokens / all_total_tokens) * 100)
        screen_share_pct = max(0, 100 - gen_share_pct)
        total_share_pct = 100
    else:
        gen_share_pct = 0
        screen_share_pct = 0
        total_share_pct = 0

    return {
        "kpi": {
            "total_cases": total_cases,
            "active_cases": active_cases,
            "closed_cases": closed_cases,
            "total_generated_names": total_generated_names,
            "active_users": active_users_count,
            "active_sub_cases": active_sub_cases,
            "completed_reviews": completed_reviews,
            "pending_review": pending_review_count,
            "under_review": under_review_count,
            "revision_required": revision_reviews,
            "submitted_for_tm_review": q_legal.count(),
            "avg_turnaround_days": avg_turnaround_days,
            "on_track_reviews": on_track_count,
            "delayed_reviews": delayed_count,
        },
        "sub_case_status_distribution": {
            "approved": approved_reviews,
            "rejected": rejected_reviews,
            "revision_required": revision_reviews,
            "under_review": under_review_count,
            "pending": pending_review_count,
            "total": q_legal.count(),
        },
        "recommendation_distribution": {
            "high": total_high,
            "medium": total_med,
            "low": total_low,
            "total": total_recommendations,
        },
        "ai_request_counts": {
            "generation_requests": gen_reqs,
            "screening_requests": screen_reqs,
        },
        "report_downloads": {
            "total": total_reports,
            "pdf": pdf_reports,
            "excel": excel_reports,
        },
        "token_consumption": {
            "summary": {
                "prompt_tokens": all_prompt_tokens,
                "completion_tokens": all_comp_tokens,
                "total_tokens": all_total_tokens,
            },
            "operations": [
                {
                    "name": "AI Name Generator",
                    "badge": f"{gen_reqs} reqs",
                    "requests": gen_reqs,
                    "prompt_tokens": gen_prompt_tokens,
                    "completion_tokens": gen_comp_tokens,
                    "total_tokens": gen_total_tokens,
                    "share_pct": gen_share_pct,
                    "color": "purple",
                },
                {
                    "name": "Brand Analysis",
                    "badge": f"{screen_reqs} reqs",
                    "requests": screen_reqs,
                    "prompt_tokens": screen_prompt_tokens,
                    "completion_tokens": screen_comp_tokens,
                    "total_tokens": screen_total_tokens,
                    "share_pct": screen_share_pct,
                    "color": "blue",
                },
            ],
            "total": {
                "requests": gen_reqs + screen_reqs,
                "prompt_tokens": all_prompt_tokens,
                "completion_tokens": all_comp_tokens,
                "total_tokens": all_total_tokens,
                "share_pct": total_share_pct,
            },
        },
    }
