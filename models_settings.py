from sqlalchemy import Column, String, DateTime, JSON, Uuid
import uuid
from datetime import datetime, timezone
from app.core.database import Base


class PlatformSettings(Base):
    __tablename__ = "platform_settings"

    id = Column(Uuid(as_uuid=True), primary_key=True, default=uuid.uuid4)
    key = Column(String(100), unique=True, nullable=False, index=True)
    value = Column(JSON, nullable=False)
    updated_at = Column(DateTime, default=lambda: datetime.now(timezone.utc), onupdate=lambda: datetime.now(timezone.utc))
