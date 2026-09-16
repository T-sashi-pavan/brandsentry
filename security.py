import time
import uuid
import logging
from datetime import datetime, timedelta, timezone
from typing import Optional
import bcrypt
from jose import jwt, JWTError
from app.core.config import settings

logger = logging.getLogger(__name__)


def verify_password(plain_password: str, hashed_password: str) -> bool:
    return bcrypt.checkpw(plain_password.encode("utf-8"), hashed_password.encode("utf-8"))


def get_password_hash(password: str) -> str:
    return bcrypt.hashpw(password.encode("utf-8"), bcrypt.gensalt()).decode("utf-8")


def create_access_token(data: dict, expires_delta: Optional[timedelta] = None) -> str:
    to_encode = data.copy()
    expire = datetime.now(timezone.utc) + (
        expires_delta or timedelta(minutes=settings.ACCESS_TOKEN_EXPIRE_MINUTES)
    )
    # H-02: every token carries a unique jti so a single token (not just
    # "all tokens for this user") can be revoked on logout/refresh-rotation.
    to_encode.setdefault("jti", uuid.uuid4().hex)
    to_encode.update({"exp": expire})
    return jwt.encode(to_encode, settings.SECRET_KEY, algorithm=settings.ALGORITHM)


def create_refresh_token(data: dict, expires_delta: Optional[timedelta] = None) -> str:
    """Long-lived companion to create_access_token (L-08). Carries the same
    identity claims (sub/email/pwd_ver) the caller passes in, plus its own
    `type: "refresh"` marker and independent `jti` so decode-side code can
    tell a refresh token apart from an access token and revoking one never
    touches the other."""
    to_encode = data.copy()
    expire = datetime.now(timezone.utc) + (
        expires_delta or timedelta(days=settings.REFRESH_TOKEN_EXPIRE_DAYS)
    )
    to_encode["type"] = "refresh"
    to_encode["jti"] = uuid.uuid4().hex
    to_encode["exp"] = expire
    return jwt.encode(to_encode, settings.SECRET_KEY, algorithm=settings.ALGORITHM)


# Revocation cache, checked first (no DB round-trip) before falling back to
# the DB-backed table below — a revocation check runs on every authenticated
# request, so the common case (nothing revoked) should stay cheap. Value is
# the epoch-seconds expiry, so a stale entry is evicted lazily on next read
# rather than needing a background sweep.
_revoked_jtis: dict = {}


def revoke_token(jti: Optional[str], ttl_seconds: int) -> None:
    """Blacklists `jti` for `ttl_seconds` (H-02) — call on logout and on
    refresh-token rotation. Written to both the in-memory cache (fast path
    for this process) and a DB table (so every other replica/worker sees the
    revocation too, not just this one)."""
    if not jti:
        return
    ttl_seconds = max(ttl_seconds, 0)
    _revoked_jtis[jti] = time.time() + ttl_seconds

    try:
        from app.core.database import SessionLocal
        from app.models.auth import RevokedToken

        expires_dt = datetime.now(timezone.utc) + timedelta(seconds=ttl_seconds)
        with SessionLocal() as db:
            existing = db.get(RevokedToken, jti)
            if existing:
                existing.expires_at = expires_dt
            else:
                db.add(RevokedToken(jti=jti, expires_at=expires_dt))
            db.commit()
    except Exception as exc:
        logger.warning("Failed to persist token revocation (DB unavailable): %s", exc)


def is_token_revoked(jti: Optional[str]) -> bool:
    if not jti:
        return False

    cached_expiry = _revoked_jtis.get(jti)
    if cached_expiry is not None:
        if cached_expiry > time.time():
            return True
        _revoked_jtis.pop(jti, None)

    try:
        from app.core.database import SessionLocal
        from app.models.auth import RevokedToken

        with SessionLocal() as db:
            row = db.get(RevokedToken, jti)
            if row is None:
                return False
            expires_at = (
                row.expires_at.replace(tzinfo=timezone.utc)
                if row.expires_at.tzinfo is None
                else row.expires_at
            )
            if expires_at <= datetime.now(timezone.utc):
                return False
            _revoked_jtis[jti] = expires_at.timestamp()
            return True
    except Exception as exc:
        logger.warning("DB revocation check failed (%s), relying on memory cache only", exc)
        return False


def decode_token(token: str) -> Optional[dict]:
    try:
        payload = jwt.decode(token, settings.SECRET_KEY, algorithms=[settings.ALGORITHM])
    except JWTError:
        return None
    if is_token_revoked(payload.get("jti")):
        return None
    return payload
