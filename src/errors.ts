export class AppError extends Error {
  status: number; code: string; retryAfterMs: number;
  constructor(message: string, status = 400, code = 'invalid_request', retryAfterMs = 0) {
    super(message); this.status = status; this.code = code; this.retryAfterMs = retryAfterMs;
  }
  get retryable() { return this.status === 429 || this.status === 502 || this.status === 503 || this.status === 504; }
}
/** A submitted Agent turn may already have executed tools and must not be replayed automatically. */
export class RuntimeExecutionError extends AppError {
  stopConfirmed: boolean;
  constructor(message: string, status = 502, stopConfirmed = true) {
    super(message,status,stopConfirmed ? 'runtime_error' : 'runtime_stop_unconfirmed');
    this.stopConfirmed = stopConfirmed;
  }
  override get retryable() { return false; }
}
export function errorMessage(error: unknown): string { return error instanceof Error ? error.message : String(error); }
