import type { ErrorCode } from "../types.js";

/** Domain error with a SPEC error code. HTTP maps this via the envelope. */
export class PlaceError extends Error {
  readonly code: ErrorCode;

  constructor(code: ErrorCode, message: string) {
    super(message);
    this.name = "PlaceError";
    this.code = code;
  }
}
