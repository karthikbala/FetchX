// The error type every FetchX module throws. `code` is a stable machine code
// shown to callers; `status` is the HTTP status it maps to; `details` is
// optional safe context (never secrets, URLs with credentials or page content).
export class GatewayError extends Error {
  constructor(code, status = 400) {
    super(code);
    this.code = code;
    this.status = status;
  }
}

export const fail = (code, status) => {
  throw new GatewayError(code, status);
};

// Identifiers callers choose (idempotency keys, rule ids, worker ids).
export const ID = /^[A-Za-z0-9_.:-]{1,160}$/;
