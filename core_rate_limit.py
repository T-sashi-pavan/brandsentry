import time
import asyncio
import hashlib
import logging
from collections import defaultdict
from typing import Dict, List, Tuple
from fastapi import Request, HTTPException, status

logger = logging.getLogger(__name__)


def get_client_ip(request: Request) -> str:
    """Real client IP, preferring X-Forwarded-For (set by a reverse proxy or
    load balancer) over the raw TCP peer address — behind a proxy,
    `request.client.host` is always the proxy's own IP, not the caller's
    (L-06). Used both for rate limiting and for audit-log ip_address."""
    forwarded = request.headers.get("X-Forwarded-For")
    if forwarded:
        return forwarded.split(",")[0].strip()
    return request.client.host if request.client else "unknown"


class SlidingWindowRateLimiter:
    """
    Sliding-window rate limiter. Primarily backed by Postgres (via the app's
    existing SessionLocal — no Redis needed) so limits are enforced
    consistently across every replica/worker instead of each keeping its own
    independent in-process counter (H-15); falls back to the original
    in-memory dict only if the DB call itself raises, so a transient DB
    hiccup degrades to per-process limiting rather than failing the request.
    """

    def __init__(self):
        self._lock = asyncio.Lock()
        # Key -> list of request timestamps (in-memory fallback only)
        self._records: Dict[str, List[float]] = defaultdict(list)

    async def check_rate_limit(
        self, key: str, max_requests: int, window_seconds: int = 60
    ) -> Tuple[bool, int]:
        """
        Check if `key` exceeds `max_requests` within `window_seconds`.
        Returns (is_allowed, retry_after_seconds).
        """
        try:
            return await asyncio.to_thread(
                self._check_rate_limit_db, key, max_requests, window_seconds
            )
        except Exception as exc:
            logger.warning(
                "Rate limit DB check failed (%s) for key %r, falling back to in-memory limiter",
                exc, key,
            )
            return await self._check_rate_limit_memory(key, max_requests, window_seconds)

    def _check_rate_limit_db(
        self, key: str, max_requests: int, window_seconds: int
    ) -> Tuple[bool, int]:
        from sqlalchemy import func
        from app.core.database import SessionLocal
        from app.models.rate_limit import RateLimitHit

        # The dependency below builds `key` from the raw Authorization
        # header/cookie value when rate-limiting by user, which can run to
        # several hundred characters (far past rate_limit_hits.key's
        # String(255)) and would otherwise mean storing live bearer tokens
        # in a database table. Hash it to a fixed-length, non-reversible
        # value instead — collisions are not a concern for a rate-limit
        # bucket, and the DB never sees the raw token.
        hashed_key = hashlib.sha256(key.encode("utf-8")).hexdigest()

        now = time.time()
        cutoff = now - window_seconds

        with SessionLocal() as db:
            db.query(RateLimitHit).filter(RateLimitHit.timestamp < cutoff).delete(
                synchronize_session=False
            )

            hit_count = (
                db.query(func.count(RateLimitHit.id))
                .filter(RateLimitHit.key == hashed_key, RateLimitHit.timestamp >= cutoff)
                .scalar()
                or 0
            )

            if hit_count >= max_requests:
                oldest = (
                    db.query(func.min(RateLimitHit.timestamp))
                    .filter(RateLimitHit.key == hashed_key, RateLimitHit.timestamp >= cutoff)
                    .scalar()
                )
                db.commit()
                retry_after = 1
                if oldest:
                    retry_after = max(1, int(oldest + window_seconds - now))
                return False, retry_after

            db.add(RateLimitHit(key=hashed_key, timestamp=now))
            db.commit()
            return True, 0

    async def _check_rate_limit_memory(
        self, key: str, max_requests: int, window_seconds: int
    ) -> Tuple[bool, int]:
        now = time.time()
        cutoff = now - window_seconds

        async with self._lock:
            timestamps = self._records[key]
            self._records[key] = [t for t in timestamps if t > cutoff]

            if len(self._records[key]) >= max_requests:
                oldest = self._records[key][0]
                retry_after = max(1, int(oldest + window_seconds - now))
                return False, retry_after

            self._records[key].append(now)
            return True, 0


# Global shared rate limiter instance
limiter = SlidingWindowRateLimiter()


def rate_limit(max_requests: int = 10, window_seconds: int = 60, by_ip: bool = False):
    """
    FastAPI dependency to rate limit endpoints.
    Can rate limit by client IP or authenticated user ID.
    """
    async def dependency(request: Request):
        if by_ip:
            key = f"ip:{get_client_ip(request)}:{request.url.path}"
        else:
            # Try to get user identifier or fallback to IP
            auth_header = request.headers.get("Authorization", "")
            cookie_token = request.cookies.get("access_token", "")
            key_id = auth_header or cookie_token or get_client_ip(request)
            key = f"user:{key_id}:{request.url.path}"

        allowed, retry_after = await limiter.check_rate_limit(
            key, max_requests=max_requests, window_seconds=window_seconds
        )

        if not allowed:
            raise HTTPException(
                status_code=status.HTTP_429_TOO_MANY_REQUESTS,
                detail=f"Rate limit exceeded. Try again in {retry_after} seconds.",
                headers={"Retry-After": str(retry_after)},
            )

    return dependency
