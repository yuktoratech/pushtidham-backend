export class AppError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public details?: unknown,
  ) {
    super(message);
  }
}
export function missing(label: string): never {
  throw new AppError(404, "NOT_FOUND", label + " not found");
}
