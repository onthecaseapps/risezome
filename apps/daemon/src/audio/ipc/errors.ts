import { UpwellError } from '@upwell/shared-types';

export class SidecarLaunchError extends UpwellError {
  constructor(message: string, options?: ErrorOptions) {
    super('sidecar-launch', message, options);
  }
}

export class SidecarIntegrityError extends UpwellError {
  constructor(message: string, options?: ErrorOptions) {
    super('sidecar-integrity', message, options);
  }
}

export class SidecarHandshakeError extends UpwellError {
  constructor(message: string, options?: ErrorOptions) {
    super('sidecar-handshake', message, options);
  }
}

export class SidecarProtocolError extends UpwellError {
  constructor(message: string, options?: ErrorOptions) {
    super('sidecar-protocol', message, options);
  }
}

export class SidecarExitError extends UpwellError {
  readonly exitCode: number | null;
  readonly stderrTail: string;

  constructor(exitCode: number | null, stderrTail: string, options?: ErrorOptions) {
    super('sidecar-exit', `Sidecar exited with code ${exitCode ?? 'null'}: ${stderrTail}`, options);
    this.exitCode = exitCode;
    this.stderrTail = stderrTail;
  }
}

export class PermissionError extends UpwellError {
  readonly reason: string;

  constructor(reason: string, options?: ErrorOptions) {
    super('permission-denied', `Audio capture permission denied: ${reason}`, options);
    this.reason = reason;
  }
}
