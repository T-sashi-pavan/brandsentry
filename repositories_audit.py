import logging
from sqlalchemy.orm import Session, joinedload
from sqlalchemy import desc, or_, and_, func
from sqlalchemy.exc import SQLAlchemyError
from typing import Optional, List, Tuple
from datetime import datetime, timezone
import uuid
from app.models.audit import AuditLog
from app.models.user import User

logger = logging.getLogger(__name__)


class AuditRepository:
    def __init__(self, db: Session):
        self.db = db

    def create(
        self,
        action: str,
        user_id: Optional[uuid.UUID] = None,
        resource_type: Optional[str] = None,
        resource_id: Optional[str] = None,
        details: Optional[str] = None,
        metadata: Optional[dict] = None,
        ip_address: Optional[str] = None,
        status: str = "success",
    ) -> Optional[AuditLog]:
        # M-22: no more silent "127.0.0.1" default — callers should pass the
        # real client IP (see app.core.rate_limit.get_client_ip); leaving it
        # unset now just leaves the field null rather than masquerading as
        # loopback.
        # Image-scan finding: an audit-log write failure used to propagate as
        # an unhandled exception (worse than "silent" — it 500s the whole
        # request, e.g. login). Now it's caught, rolled back, logged, and
        # returns None so a logging failure never blocks the action it was
        # trying to record.
        try:
            log = AuditLog(
                user_id=user_id,
                action=action,
                resource_type=resource_type,
                resource_id=str(resource_id) if resource_id else None,
                details=details,
                log_metadata=metadata,
                ip_address=ip_address,
                status=status,
                created_at=datetime.now(timezone.utc),
            )
            self.db.add(log)
            self.db.commit()
            self.db.refresh(log)
            return log
        except Exception as exc:
            try:
                self.db.rollback()
            except SQLAlchemyError as rollback_exc:
                logger.warning("Rollback failed after audit log write error for action '%s': %s", action, rollback_exc)
            logger.error("Failed to persist audit log entry for action '%s': %s", action, exc, exc_info=True)
            return None

    def _build_filter_query(
        self,
        user_id: Optional[uuid.UUID] = None,
        action: Optional[str] = None,
        resource_type: Optional[str] = None,
        search: Optional[str] = None,
        date_from: Optional[datetime] = None,
        date_to: Optional[datetime] = None,
    ):
        q = self.db.query(AuditLog).outerjoin(User, AuditLog.user_id == User.id)

        if user_id:
            q = q.filter(AuditLog.user_id == user_id)
        if action and action.strip() and action.strip() != "all":
            act_clean = action.strip()
            act_under = act_clean.replace(" ", "_")
            act_space = act_clean.replace("_", " ")
            q = q.filter(
                or_(
                    AuditLog.action.ilike(f"%{act_clean}%"),
                    AuditLog.action.ilike(f"%{act_under}%"),
                    func.replace(AuditLog.action, '_', ' ').ilike(f"%{act_space}%"),
                )
            )
        if resource_type and resource_type.strip() and resource_type.strip() != "all":
            q = q.filter(AuditLog.resource_type == resource_type.strip())
        if date_from:
            q = q.filter(AuditLog.created_at >= date_from)
        if date_to:
            q = q.filter(AuditLog.created_at <= date_to)
        if search and search.strip():
            raw_search = search.strip()
            tokens = [t for t in raw_search.split() if t]

            search_underscore = raw_search.replace(" ", "_")
            search_space = raw_search.replace("_", " ")

            s_raw = f"%{raw_search}%"
            s_under = f"%{search_underscore}%"
            s_space = f"%{search_space}%"

            # 1. Direct and space-agnostic action matches
            action_match = or_(
                AuditLog.action.ilike(s_raw),
                AuditLog.action.ilike(s_under),
                func.replace(AuditLog.action, '_', ' ').ilike(s_space),
                func.replace(AuditLog.action, '_', ' ').ilike(s_raw),
            )

            # 2. General field matching
            field_match = or_(
                action_match,
                AuditLog.details.ilike(s_raw),
                AuditLog.resource_id.ilike(s_raw),
                AuditLog.ip_address.ilike(s_raw),
                User.email.ilike(s_raw),
                User.full_name.ilike(s_raw),
            )

            # 3. Token-based multi-keyword matching (e.g. "settings update", "brand screening", "user name + action")
            if len(tokens) > 1:
                token_conditions = []
                for tok in tokens:
                    t_str = f"%{tok}%"
                    tok_or = or_(
                        AuditLog.action.ilike(t_str),
                        func.replace(AuditLog.action, '_', ' ').ilike(t_str),
                        AuditLog.details.ilike(t_str),
                        AuditLog.resource_id.ilike(t_str),
                        AuditLog.ip_address.ilike(t_str),
                        User.email.ilike(t_str),
                        User.full_name.ilike(t_str),
                    )
                    token_conditions.append(tok_or)

                q = q.filter(or_(field_match, and_(*token_conditions)))
            else:
                q = q.filter(field_match)

        return q

    def get_logs(
        self,
        page: int = 1,
        page_size: int = 20,
        user_id: Optional[uuid.UUID] = None,
        action: Optional[str] = None,
        resource_type: Optional[str] = None,
        search: Optional[str] = None,
        date_from: Optional[datetime] = None,
        date_to: Optional[datetime] = None,
    ) -> Tuple[List[AuditLog], int]:
        q = self._build_filter_query(
            user_id=user_id,
            action=action,
            resource_type=resource_type,
            search=search,
            date_from=date_from,
            date_to=date_to,
        ).options(joinedload(AuditLog.user))

        total = q.count()
        items = q.order_by(desc(AuditLog.created_at)).offset((page - 1) * page_size).limit(page_size).all()
        return items, total

    def get_stats(
        self,
        user_id: Optional[uuid.UUID] = None,
        action: Optional[str] = None,
        resource_type: Optional[str] = None,
        search: Optional[str] = None,
        date_from: Optional[datetime] = None,
        date_to: Optional[datetime] = None,
    ) -> dict:
        q = self._build_filter_query(
            user_id=user_id,
            action=action,
            resource_type=resource_type,
            search=search,
            date_from=date_from,
            date_to=date_to,
        )

        total = q.count()
        logins = q.filter(AuditLog.action.in_(["LOGIN", "LOGOUT"])).count()
        exports = q.filter(AuditLog.action == "EXPORT").count()
        screenings = q.filter(AuditLog.action == "BRAND_SCREENING").count()
        generations = q.filter(AuditLog.action == "GENERATE_BRAND_NAMES").count()

        return {
            "total": total,
            "logins": logins,
            "exports": exports,
            "screenings": screenings,
            "generations": generations,
        }
