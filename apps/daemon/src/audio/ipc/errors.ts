import { RisezomeError } from '@risezome/shared-types';

export class SidecarLaunchError extends RisezomeError {
  constructor(message: string, options?: ErrorOptions) {
    super('sidecar-launch', message, options);
  }
}

export class SidecarIntegrityError extends RisezomeError {
  constructor(message: string, options?: ErrorOptions) {
    super('sidecar-integrity', message, options);
  }
}

export class SidecarHandshakeError extends RisezomeError {
  constructor(message: string, options?: ErrorOptions) {
    super('sidecar-handshake', message, options);
  }
}

export class SidecarProtocolError extends RisezomeError {
  constructor(message: string, options?: ErrorOptions) {
    super('sidecar-protocol', message, options);
  }
}

export class SidecarExitError extends RisezomeError {
  readonly exitCode: number | null;
  readonly stderrTail: string;

  constructor(exitCode: number | null, stderrTail: string, options?: ErrorOptions) {
    super('sidecar-exit', `Sidecar exited with code ${exitCode ?? 'null'}: ${stderrTail}`, options);
    this.exitCode = exitCode;
    this.stderrTail = stderrTail;
  }
}

export class PermissionError extends RisezomeError {
  readonly reason: string;

  constructor(reason: string, options?: ErrorOptions) {
    super('permission-denied', `Audio capture permission denied: ${reason}`, options);
    this.reason = reason;
  }
}
