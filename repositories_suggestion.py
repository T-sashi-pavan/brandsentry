import uuid
from datetime import datetime, timezone
from typing import List, Optional
from sqlalchemy import desc, func
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session
from app.models.suggestion import BrandSuggestionForm

_MAX_CASE_ID_ATTEMPTS = 5


def _next_case_id(db: Session) -> str:
    year = datetime.now(timezone.utc).year
    prefix = f"SUN-{year}-"
    last = (
        db.query(BrandSuggestionForm)
        .filter(BrandSuggestionForm.case_id.like(f"{prefix}%"))
        .order_by(desc(BrandSuggestionForm.case_id))
        .first()
    )
    seq = 1
    if last:
        try:
            seq = int(last.case_id[len(prefix):]) + 1
        except ValueError:
            pass
    return f"{prefix}{seq:04d}"


class SuggestionRepository:
    def __init__(self, db: Session):
        self.db = db

    def create(self, data: dict, user_id: Optional[uuid.UUID] = None) -> BrandSuggestionForm:
        fields = {k: v for k, v in data.items() if k not in ("case_id", "user_id", "id")}
        # Two concurrent saves can read the same "last case_id" before either
        # commits; retry with a freshly-computed case_id on the resulting
        # unique-constraint violation rather than letting one request 500 or
        # silently overwrite the other's sequence number.
        for attempt in range(_MAX_CASE_ID_ATTEMPTS):
            case_id = _next_case_id(self.db)
            form = BrandSuggestionForm(case_id=case_id, user_id=user_id, **fields)
            self.db.add(form)
            try:
                self.db.commit()
            except IntegrityError:
                self.db.rollback()
                if attempt == _MAX_CASE_ID_ATTEMPTS - 1:
                    raise
                continue
            self.db.refresh(form)
            return form
        raise RuntimeError("Unreachable")  # pragma: no cover

    def list_all(self, user_id: Optional[uuid.UUID] = None) -> List[BrandSuggestionForm]:
        query = self.db.query(BrandSuggestionForm)
        if user_id:
            query = query.filter(BrandSuggestionForm.user_id == user_id)
        return query.order_by(desc(BrandSuggestionForm.created_at)).all()

    def get_by_case_id(self, case_id: str) -> Optional[BrandSuggestionForm]:
        return (
            self.db.query(BrandSuggestionForm)
            .filter(BrandSuggestionForm.case_id == case_id)
            .first()
        )

    def find_duplicate(
        self, generic_name: str, division: Optional[str] = None, dosage_form: Optional[str] = None,
    ) -> Optional[BrandSuggestionForm]:
        """A case is considered duplicate if the Molecule (generic_name) matches an existing
        case case-insensitively.
        1. If both have a division, and divisions match, it's an exact division match.
        2. Even if dosage forms differ (e.g. 'Topical Ointment 2' vs 'Topical Ointment 2 w/w')
           or division is empty/unspecified, cases for the same molecule belong together."""
        clean_name = (generic_name or "").strip().lower()
        if not clean_name:
            return None

        clean_div = (division or "").strip().lower()

        # If division is specified, first check if there's a match with same division
        if clean_div:
            same_div = (
                self.db.query(BrandSuggestionForm)
                .filter(
                    func.lower(func.trim(BrandSuggestionForm.generic_name)) == clean_name,
                    func.lower(func.trim(func.coalesce(BrandSuggestionForm.division, ''))) == clean_div,
                )
                .order_by(desc(BrandSuggestionForm.created_at))
                .first()
            )
            if same_div:
                return same_div

        # Check if same molecule already exists
        return (
            self.db.query(BrandSuggestionForm)
            .filter(
                func.lower(func.trim(BrandSuggestionForm.generic_name)) == clean_name,
            )
            .order_by(desc(BrandSuggestionForm.created_at))
            .first()
        )

    def update(self, case_id: str, data: dict) -> Optional[BrandSuggestionForm]:
        form = self.get_by_case_id(case_id)
        if not form:
            return None
        fields = {k: v for k, v in data.items() if k not in ("case_id", "user_id", "id")}
        for k, v in fields.items():
            if hasattr(form, k):
                setattr(form, k, v)
        form.updated_at = datetime.now(timezone.utc)
        self.db.commit()
        self.db.refresh(form)
        return form

    def delete(self, case_id: str) -> bool:
        form = self.get_by_case_id(case_id)
        if not form:
            return False
        self.db.delete(form)
        self.db.commit()
        return True
