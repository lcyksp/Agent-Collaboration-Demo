from __future__ import annotations

from dataclasses import dataclass
from http import HTTPStatus


@dataclass(slots=True)
class AppError(Exception):
    """Base domain/application exception with HTTP mapping."""

    message: str
    code: str = "app_error"
    status_code: int = HTTPStatus.BAD_REQUEST

    def __str__(self) -> str:
        return f"[{self.code}] {self.message}"


class InfrastructureError(AppError):
    def __init__(self, message: str, code: str = "infrastructure_error") -> None:
        super().__init__(message=message, code=code, status_code=HTTPStatus.SERVICE_UNAVAILABLE)


class ValidationError(AppError):
    def __init__(self, message: str, code: str = "validation_error") -> None:
        super().__init__(message=message, code=code, status_code=HTTPStatus.UNPROCESSABLE_ENTITY)

