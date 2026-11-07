export class ContractError extends Error {
  constructor(
    public code: string,
    message: string,
    public exitCode = 2,
    public details?: unknown,
  ) {
    super(message);
  }
}

export function requireCondition(
  condition: unknown,
  code: string,
  message: string,
  exitCode = 2,
): asserts condition {
  if (!condition) throw new ContractError(code, message, exitCode);
}
