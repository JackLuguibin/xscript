"""Typed errors for a user-configured AScript-compatible vision service."""


class AsaiError(Exception):
    def __init__(self, message, type=None, status_code=None, request_id=None):
        super().__init__(message)
        self.message, self.type = message, type
        self.status_code, self.request_id = status_code, request_id


class NotReadyError(AsaiError): pass
class InvalidRequestError(AsaiError): pass
class AuthenticationError(AsaiError): pass
class CredentialExpiredError(AuthenticationError): pass
class InsufficientBalanceError(AsaiError): pass
class ServiceUnavailableError(AsaiError): pass
class QuotaExhaustedError(ServiceUnavailableError): pass
class UpstreamError(AsaiError): pass
class NetworkError(AsaiError): pass
class ProtocolError(AsaiError): pass


class RateLimitError(AsaiError):
    def __init__(self, message, retry_after=None, **kwargs):
        super().__init__(message, **kwargs)
        self.retry_after = retry_after


def from_response(status_code, payload, request_id=None, retry_after=None):
    detail = payload.get("error", {}) if isinstance(payload, dict) else {}
    if not isinstance(detail, dict):
        detail = {}
    kind = detail.get("type")
    types = {
        "invalid_api_key": AuthenticationError, "credential_expired": CredentialExpiredError,
        "insufficient_balance": InsufficientBalanceError, "rate_limit_error": RateLimitError,
        "upstream_quota_exhausted": QuotaExhaustedError, "upstream_error": UpstreamError,
        "invalid_request_error": InvalidRequestError,
        "balance_unavailable": ServiceUnavailableError, "account_unavailable": ServiceUnavailableError,
        "vision_unconfigured": ServiceUnavailableError, "api_error": ServiceUnavailableError,
    }
    statuses = {400: InvalidRequestError, 401: AuthenticationError, 402: InsufficientBalanceError,
                404: InvalidRequestError, 413: InvalidRequestError, 415: InvalidRequestError,
                429: RateLimitError, 500: ServiceUnavailableError, 502: UpstreamError,
                503: ServiceUnavailableError, 504: UpstreamError}
    cls = types.get(kind, statuses.get(status_code, AsaiError))
    kwargs = dict(type=kind, status_code=status_code,
                  request_id=detail.get("request_id") or request_id)
    if cls is RateLimitError:
        kwargs["retry_after"] = retry_after
    return cls(str(detail.get("message") or "Vision service returned HTTP %s" % status_code), **kwargs)
