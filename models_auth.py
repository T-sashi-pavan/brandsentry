from datetime import datetime, timezone
from sqlalchemy import Column, DateTime, String
from app.core.database import Base


class RevokedToken(Base):
    """JTI blacklist for server-side JWT revocation (H-02). A row here means
    the token that carried this jti must be rejected even though its
    signature/expiry are otherwise still valid — written on logout and on
    refresh-token rotation, checked by app.core.security.is_token_revoked().
    `expires_at` mirrors the token's own expiry so a row past that point is
    known-harmless (the token would fail expiry validation anyway) and can
    be pruned without risk of dropping a still-relevant revocation."""

    __tablename__ = "revoked_tokens"

    jti = Column(String(64), primary_key=True)
    revoked_at = Column(DateTime, default=lambda: datetime.now(timezone.utc))
    expires_at = Column(DateTime, nullable=False)
