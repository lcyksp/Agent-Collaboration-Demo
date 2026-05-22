from __future__ import annotations

from dataclasses import dataclass
from typing import Any

from app.core.config import Settings
from app.shared.exceptions.base import InfrastructureError, ValidationError


@dataclass(slots=True, frozen=True)
class ModelRoute:
    provider: str
    model: str


class LiteLLMRouterFactory:
    """
    LiteLLM router factory abstraction.
    Can be swapped with real `litellm.Router` initialization.
    """

    def __init__(self, settings: Settings) -> None:
        self._settings = settings

    def parse_model_route(self, model_name: str | None = None) -> ModelRoute:
        raw_name = model_name or self._settings.llm_default_model
        if "/" not in raw_name:
            raise ValidationError(
                "Model route must follow '<provider>/<model>' format.",
                code="invalid_model_route",
            )
        provider, model = raw_name.split("/", 1)
        if not provider or not model:
            raise ValidationError("Model route contains empty provider or model.", code="invalid_model_route")
        return ModelRoute(provider=provider, model=model)

    def build(self) -> dict[str, Any]:
        """
        Return a serializable router config for now.
        Replace by actual LiteLLM Router object in integration stage.
        """
        try:
            route = self.parse_model_route()
            return {
                "default_provider": route.provider,
                "default_model": route.model,
                "timeout_seconds": self._settings.llm_timeout_seconds,
                "api_base": self._settings.litellm_api_base,
                "api_key_set": bool(self._settings.litellm_api_key),
            }
        except ValidationError:
            raise
        except Exception as exc:
            raise InfrastructureError(f"Failed to build LLM router config: {exc}", code="llm_router_build_failed") from exc

