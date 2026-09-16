from sqlalchemy.orm import Session
from app.core.config import settings as app_settings
from app.models.settings import PlatformSettings

DEFAULT_RISK_WEIGHTS = {
    "spelling": 0.40,
    "phonetic": 0.20,
    "conceptual": 0.20,
    "visual": 0.20,
}

DEFAULT_GRADE_THRESHOLDS = {
    "A": {"min": 0, "max": 30},
    "B": {"min": 31, "max": 50},
    "C": {"min": 51, "max": 70},
    "D": {"min": 71, "max": 100},
}

RISK_WEIGHTS_KEY = "risk_weights"
GRADE_THRESHOLDS_KEY = "grade_thresholds"
COMBINATION_RULES_KEY = "combination_rules"
DATA_SOURCE_TOGGLES_KEY = "data_source_toggles"


class SettingsRepository:
    def __init__(self, db: Session):
        self.db = db

    def get_risk_weights(self) -> dict:
        from app.core.cache import cache_service
        cached = cache_service.get_json("platform_settings:risk_weights")
        if cached:
            return cached
        row = self.db.query(PlatformSettings).filter_by(key=RISK_WEIGHTS_KEY).first()
        val = row.value if row else DEFAULT_RISK_WEIGHTS.copy()
        cache_service.set_json("platform_settings:risk_weights", val, ttl_seconds=300)
        return val

    def update_risk_weights(self, weights: dict) -> dict:
        from app.core.cache import cache_service
        row = self.db.query(PlatformSettings).filter_by(key=RISK_WEIGHTS_KEY).first()
        if row:
            row.value = weights
        else:
            row = PlatformSettings(key=RISK_WEIGHTS_KEY, value=weights)
            self.db.add(row)
        self.db.commit()
        self.db.refresh(row)
        cache_service.delete("platform_settings:risk_weights")
        return row.value

    def get_data_source_toggles(self) -> dict:
        """Live on/off state for each Brand Analysis data source."""
        from app.core.cache import cache_service
        cached = cache_service.get_json("platform_settings:data_source_toggles")
        if cached:
            return cached
        row = self.db.query(PlatformSettings).filter_by(key=DATA_SOURCE_TOGGLES_KEY).first()
        if row:
            val = row.value
        else:
            val = {
                "who_inn_enabled": app_settings.WHO_INN_ENABLED,
                "iqvia_enabled": app_settings.IQVIA_ENABLED,
                "epharmacy_enabled": app_settings.EPHARMACY_SCRAPE_ENABLED,
                "google_search_enabled": app_settings.GOOGLE_SEARCH_ENABLED,
            }
        cache_service.set_json("platform_settings:data_source_toggles", val, ttl_seconds=60)
        return val

    def set_data_source_toggle(self, source_id: str, enabled: bool) -> dict:
        from app.core.cache import cache_service
        toggles = self.get_data_source_toggles().copy()
        toggles[source_id] = enabled
        row = self.db.query(PlatformSettings).filter_by(key=DATA_SOURCE_TOGGLES_KEY).first()
        if row:
            row.value = toggles
        else:
            row = PlatformSettings(key=DATA_SOURCE_TOGGLES_KEY, value=toggles)
            self.db.add(row)
        self.db.commit()
        self.db.refresh(row)
        cache_service.delete("platform_settings:data_source_toggles")
        return row.value

    def get_grade_thresholds(self) -> dict:
        from app.core.cache import cache_service
        cached = cache_service.get_json("platform_settings:grade_thresholds")
        if cached:
            return cached
        row = self.db.query(PlatformSettings).filter_by(key=GRADE_THRESHOLDS_KEY).first()
        val = row.value if (row and isinstance(row.value, dict)) else DEFAULT_GRADE_THRESHOLDS.copy()
        cache_service.set_json("platform_settings:grade_thresholds", val, ttl_seconds=300)
        return val

    def update_grade_thresholds(self, thresholds: dict) -> dict:
        from app.core.cache import cache_service
        row = self.db.query(PlatformSettings).filter_by(key=GRADE_THRESHOLDS_KEY).first()
        if row:
            row.value = thresholds
        else:
            row = PlatformSettings(key=GRADE_THRESHOLDS_KEY, value=thresholds)
            self.db.add(row)
        self.db.commit()
        self.db.refresh(row)
        cache_service.delete("platform_settings:grade_thresholds")
        return row.value

    def get_combination_rules(self) -> dict:
        from app.core.cache import cache_service
        cached = cache_service.get_json("platform_settings:combination_rules")
        # `{}` is the documented default when no custom rules row exists, and it
        # is falsy — so `if cached:` never hit and every _score call re-queried
        # platform_settings. Same value returned either way; only the repeat
        # query disappears.
        if cached is not None:
            return cached
        row = self.db.query(PlatformSettings).filter_by(key=COMBINATION_RULES_KEY).first()
        val = row.value if (row and isinstance(row.value, dict)) else {}
        cache_service.set_json("platform_settings:combination_rules", val, ttl_seconds=300)
        return val

    def update_combination_rules(self, rules: dict) -> dict:
        from app.core.cache import cache_service
        row = self.db.query(PlatformSettings).filter_by(key=COMBINATION_RULES_KEY).first()
        if row:
            row.value = rules
        else:
            row = PlatformSettings(key=COMBINATION_RULES_KEY, value=rules)
            self.db.add(row)
        self.db.commit()
        self.db.refresh(row)
        cache_service.delete("platform_settings:combination_rules")
        return row.value
