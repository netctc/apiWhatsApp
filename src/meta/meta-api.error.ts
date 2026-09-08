export interface MetaApiErrorOptions {
  httpStatus?: number;
  code?: number;
  subcode?: number;
  retryable: boolean;
  response?: unknown;
}

export class MetaApiError extends Error {
  readonly httpStatus?: number;
  readonly code?: number;
  readonly subcode?: number;
  readonly retryable: boolean;
  readonly response?: unknown;

  constructor(message: string, options: MetaApiErrorOptions) {
    super(message);
    this.name = "MetaApiError";
    this.httpStatus = options.httpStatus;
    this.code = options.code;
    this.subcode = options.subcode;
    this.retryable = options.retryable;
    this.response = options.response;
  }
}
