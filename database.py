from sqlalchemy import create_engine, text
from sqlalchemy.orm import declarative_base, sessionmaker
from app.core.config import settings

_is_sqlite = settings.DATABASE_URL.startswith("sqlite")

_engine_kwargs: dict = {}
if _is_sqlite:
    _engine_kwargs["connect_args"] = {"check_same_thread": False}
else:
    # Kept deliberately small: this app shares a connection-limited RDS
    # instance with several other environments. A single /brands/generate
    # call peaks at 6 connections (1 request session + up to 5 concurrent
    # Stage-4 candidate-screening workers, see generator.py's
    # _PARALLEL_SCREENING_CONCURRENCY) — pool_size+max_overflow just needs
    # headroom for a couple of those calls at once, not this process's
    # theoretical max.
    _engine_kwargs["pool_pre_ping"] = True
    _engine_kwargs["pool_size"] = 3
    _engine_kwargs["max_overflow"] = 3
    _engine_kwargs["pool_recycle"] = 120
    _engine_kwargs["pool_timeout"] = 25
    _engine_kwargs["connect_args"] = {
        "keepalives": 1,
        "keepalives_idle": 30,
        "keepalives_interval": 10,
        "keepalives_count": 5,
    }

engine = create_engine(settings.DATABASE_URL, **_engine_kwargs)

SessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine)

Base = declarative_base()


def get_db():
    db = SessionLocal()
    try:
        yield db
    finally:
        try:
            db.close()
        except Exception:
            pass


def seed_defaults(db: SessionLocal):
    try:
        from app.models.user import User
        from app.core.security import get_password_hash
        default_users = [
            ("superadmin@pharmabi.com", "Super Admin", "Password@123", "super_admin", "Executive", True),
            ("admin@pharmabi.com", "Admin User", "Password@123", "admin", "Operations", False),
            ("branduser@pharmabi.com", "Brand Marketing User", "Password@123", "brand_market_user", "Brand Marketing", False),
            ("trademarkuser@pharmabi.com", "Trademark Reviewer", "Password@123", "trademark_user", "Legal & Trademark", False),
            ("business@pharmabi.com", "Business User", "Password@123", "business_team", "Commercial", False),
        ]
        for email, full_name, pwd, role, dept, is_super in default_users:
            existing = db.query(User).filter(User.email == email).first()
            if not existing:
                u = User(
                    email=email,
                    full_name=full_name,
                    hashed_password=get_password_hash(pwd),
                    role=role,
                    department=dept,
                    is_active=True,
                    is_superuser=is_super,
                )
                db.add(u)
        db.commit()
    except Exception:
        db.rollback()


def create_tables():
    # Register newer models (H-02 revocation table, H-15 rate-limit table)
    # so create_all() below actually creates them — mirrors how every other
    # model reaches Base.metadata via import elsewhere in the app.
    from app.models import auth as _auth_models  # noqa: F401
    from app.models import rate_limit as _rate_limit_models  # noqa: F401
    from app.models import token_usage as _token_usage_models  # noqa: F401

    Base.metadata.create_all(bind=engine)
    if not _is_sqlite:
        try:
            with engine.connect() as conn:
                existing_iqvia_cols = {
                    r[0] for r in conn.execute(text(
                        "SELECT column_name FROM information_schema.columns WHERE table_name = 'iqvia_extract';"
                    )).fetchall()
                }
            with engine.begin() as conn:
                conn.execute(text("SET LOCAL lock_timeout = '4s';"))
                # Granular RBAC — per-user permission overrides (NULL = inherit role defaults)
                conn.execute(text("ALTER TABLE users ADD COLUMN IF NOT EXISTS custom_permissions JSON;"))
                if "brand_ims" not in existing_iqvia_cols:
                    conn.execute(text("ALTER TABLE brand_suggestion_forms ADD COLUMN IF NOT EXISTS description TEXT;"))
                    conn.execute(text("ALTER TABLE brand_suggestion_forms ADD COLUMN IF NOT EXISTS naming_information JSON;"))
                    conn.execute(text("ALTER TABLE brand_suggestion_forms ADD COLUMN IF NOT EXISTS molecule_history_information JSON;"))
                    conn.execute(text("ALTER TABLE iqvia_extract ADD COLUMN IF NOT EXISTS brand_ims VARCHAR(255);"))
                    conn.execute(text("ALTER TABLE iqvia_extract ADD COLUMN IF NOT EXISTS molecules TEXT;"))
                    conn.execute(text("ALTER TABLE iqvia_extract ADD COLUMN IF NOT EXISTS atc_iv VARCHAR(100);"))
                    conn.execute(text("ALTER TABLE iqvia_extract ADD COLUMN IF NOT EXISTS company VARCHAR(255);"))
                    conn.execute(text("ALTER TABLE iqvia_extract ADD COLUMN IF NOT EXISTS product_launch VARCHAR(20);"))
                    conn.execute(text("ALTER TABLE iqvia_extract ADD COLUMN IF NOT EXISTS val_mat_current DOUBLE PRECISION;"))
                    conn.execute(text("ALTER TABLE iqvia_extract ADD COLUMN IF NOT EXISTS val_mat_prev DOUBLE PRECISION;"))
                    conn.execute(text("ALTER TABLE iqvia_extract ADD COLUMN IF NOT EXISTS val_gr_pct DOUBLE PRECISION;"))
                    conn.execute(text("ALTER TABLE iqvia_extract ADD COLUMN IF NOT EXISTS un_mat_current DOUBLE PRECISION;"))
                    conn.execute(text("ALTER TABLE iqvia_extract ADD COLUMN IF NOT EXISTS un_mat_prev DOUBLE PRECISION;"))
                    conn.execute(text("ALTER TABLE iqvia_extract ADD COLUMN IF NOT EXISTS un_gr_pct DOUBLE PRECISION;"))
                    conn.execute(text("ALTER TABLE iqvia_extract ADD COLUMN IF NOT EXISTS no_of_mol INTEGER;"))
                    conn.execute(text("ALTER TABLE iqvia_extract ADD COLUMN IF NOT EXISTS plain_comb VARCHAR(50);"))
                    conn.execute(text("ALTER TABLE iqvia_extract ADD COLUMN IF NOT EXISTS is_active BOOLEAN DEFAULT TRUE;"))
                    conn.execute(text("ALTER TABLE screening_results ADD COLUMN IF NOT EXISTS iqvia_review_note TEXT;"))
                    conn.execute(text("ALTER TABLE screening_results ADD COLUMN IF NOT EXISTS grades JSON;"))
                    conn.execute(text("ALTER TABLE screening_results ADD COLUMN IF NOT EXISTS combination VARCHAR(10);"))
        except Exception:
            pass

        # L-02: index on legal_reviews.proposed_by_id for an already-provisioned
        # DB — create_all() above only creates brand-new tables, it never alters
        # an existing one's indexes, so this covers upgrades in place.
        try:
            with engine.begin() as conn:
                conn.execute(text(
                    "CREATE INDEX IF NOT EXISTS idx_legal_reviews_proposed_by_id "
                    "ON legal_reviews(proposed_by_id);"
                ))
                conn.execute(text(
                    "CREATE INDEX IF NOT EXISTS idx_legal_review_batches_proposed_by_id "
                    "ON legal_review_batches(proposed_by_id);"
                ))
        except Exception:
            pass

        # L-03: uniqueness on (generated_name, user_id, case_id) for an
        # already-provisioned DB. Postgres has no "ADD CONSTRAINT IF NOT
        # EXISTS", so check pg_constraint first — otherwise this would raise
        # (and roll back) on every restart once the constraint already exists.
        try:
            with engine.begin() as conn:
                already_exists = conn.execute(text(
                    "SELECT 1 FROM pg_constraint WHERE conname = 'uq_generated_name_user_case';"
                )).first()
                if not already_exists:
                    conn.execute(text(
                        "ALTER TABLE generated_brand_names ADD CONSTRAINT "
                        "uq_generated_name_user_case UNIQUE (generated_name, user_id, case_id);"
                    ))
        except Exception:
            pass

    # Seed default user accounts
    db = SessionLocal()
    try:
        seed_defaults(db)
    finally:
        db.close()

