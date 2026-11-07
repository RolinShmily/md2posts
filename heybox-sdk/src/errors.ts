export class HeyBoxError extends Error {
  public readonly code?: string | number;
  public readonly detail?: unknown;

  constructor(message: string, code?: string | number, detail?: unknown) {
    super(message);
    this.name = 'HeyBoxError';
    this.code = code;
    this.detail = detail;
  }
}
