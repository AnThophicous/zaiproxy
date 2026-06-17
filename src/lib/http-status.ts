export function upstreamStatus(message: string): 400 | 401 | 404 | 429 | 502 {
  if (/MODEL_NOT_FOUND/i.test(message)) {
    return 404;
  }
  if (/UNSUPPORTED_MODEL_FEATURE|UNSUPPORTED_PARAMETER|invalid request/i.test(message)) {
    return 400;
  }
  if (/cooldown|cooling down|try again soon|rate.?limit|too many|quota|usage exceeds/i.test(message)) {
    return 429;
  }
  if (/No usable|No active|login|auth|unauthorized|invalid token|token expired/i.test(message)) {
    return 401;
  }
  return 502;
}

export function upstreamErrorCode(status: number): string {
  if (status === 404) {
    return "model_not_found";
  }
  if (status === 400) {
    return "invalid_request_error";
  }
  if (status === 429) {
    return "rate_limit_exceeded";
  }
  if (status === 401) {
    return "invalid_api_key";
  }
  return "upstream_error";
}

export function upstreamErrorType(status: number): string {
  if (status === 400 || status === 404) {
    return "invalid_request_error";
  }
  if (status === 401) {
    return "authentication_error";
  }
  if (status === 429) {
    return "rate_limit_error";
  }
  return "server_error";
}
