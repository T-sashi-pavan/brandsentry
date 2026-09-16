import uuid
from datetime import datetime, timezone
from sqlalchemy import Column, String, Integer, DateTime, Uuid
from app.core.database import Base


class TokenUsage(Base):
    """One row per LLM call whose provider returned real token counts (L-29)
    — replaces the dashboard/reports' previous hardcoded multiplier/floor
    estimates with actual measured usage."""

    __tablename__ = "token_usage"

    id = Column(Uuid(as_uuid=True), primary_key=True, default=uuid.uuid4)
    feature_name = Column(String(100), nullable=False, index=True)
    model_id = Column(String(100), nullable=True)
    prompt_tokens = Column(Integer, default=0, nullable=False)
    completion_tokens = Column(Integer, default=0, nullable=False)
    total_tokens = Column(Integer, default=0, nullable=False)
    user_id = Column(Uuid(as_uuid=True), nullable=True)
    created_at = Column(DateTime(timezone=True), default=lambda: datetime.now(timezone.utc), index=True)
