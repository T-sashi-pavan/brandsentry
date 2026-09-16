from sqlalchemy import Column, Float, Integer, String
from app.core.database import Base


class RateLimitHit(Base):
    """One row per request counted toward a sliding-window rate limit
    (H-15). DB-backed so limits hold consistently across every
    replica/worker rather than each keeping its own in-process counter — no
    Redis needed since this app already runs Postgres. Rows older than the
    caller's window are pruned opportunistically on each check in
    app.core.rate_limit.

    `id` (autoincrement Integer) and `timestamp` (Float, time.time() epoch
    seconds) match the already-provisioned rate_limit_hits table's real
    column types (verified against the reference repo's model on the EC2
    host — that's what originally created this table). create_all() never
    alters an existing table's column types, so the model has to match
    what's really there rather than the other way around."""

    __tablename__ = "rate_limit_hits"

    id = Column(Integer, primary_key=True, autoincrement=True)
    key = Column(String(255), nullable=False, index=True)
    timestamp = Column(Float, nullable=False, index=True)
