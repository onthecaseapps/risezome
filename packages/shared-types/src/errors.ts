export class RisezomeError extends Error {
  readonly code: string;

  constructor(code: string, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = this.constructor.name;
    this.code = code;
  }
}

export class IllegalStateError extends RisezomeError {
  constructor(message: string, options?: ErrorOptions) {
    super('illegal-state', message, options);
  }
}

export class NotImplementedError extends RisezomeError {
  constructor(message: string, options?: ErrorOptions) {
    super('not-implemented', message, options);
  }
}
