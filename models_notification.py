from sqlalchemy import Column, String, Boolean, Text, DateTime, ForeignKey, Uuid
from sqlalchemy.orm import relationship
import uuid
from datetime import datetime, timezone
from app.core.database import Base


class Notification(Base):
    __tablename__ = "notifications"

    id = Column(Uuid(as_uuid=True), primary_key=True, default=uuid.uuid4)
    user_id = Column(Uuid(as_uuid=True), ForeignKey("users.id"), nullable=False, index=True)

    # "legal_submitted" | "legal_approved" | "legal_rejected" | "legal_needs_revision" | "legal_retracted"
    type = Column(String(100), nullable=False)
    title = Column(String(255), nullable=False)
    message = Column(Text, nullable=False)

    resource_id = Column(Uuid(as_uuid=True), nullable=True)   # legal_review id

    is_read = Column(Boolean, default=False, nullable=False)
    created_at = Column(DateTime, default=lambda: datetime.now(timezone.utc))

    user = relationship("User", back_populates="notifications")
