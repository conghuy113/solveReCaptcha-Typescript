// SPDX-License-Identifier: AGPL-3.0-only

export class CdpError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = new.target.name;
  }
}

export class CdpConnectionError extends CdpError {}

export class CdpProtocolError extends CdpError {
  readonly method: string;
  readonly code: number | undefined;
  readonly data: unknown;

  constructor(
    method: string,
    message: string,
    options: { code?: number; data?: unknown; cause?: unknown } = {},
  ) {
    super(`${method}: ${message}`, options.cause === undefined ? undefined : { cause: options.cause });
    this.method = method;
    this.code = options.code;
    this.data = options.data;
  }
}
