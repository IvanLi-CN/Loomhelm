export const sourceLineLimit = 400;
export const testLineLimit = 600;

export function physicalLineCount(contents: string): number {
  return contents === ""
    ? 0
    : contents.split(/\r\n|[\n\r\u2028\u2029]/).length -
        Number(/[\n\r\u2028\u2029]$/.test(contents));
}

export function sourcePolicyFailure(
  path: string,
  contents: string,
): string | null {
  const testFile = /(?:^|[\\/])(?:tests|native-tests)[\\/]/.test(path);
  const limit = testFile ? testLineLimit : sourceLineLimit;
  const lines = physicalLineCount(contents);
  return lines > limit
    ? `${path}: ${lines} physical lines exceeds ${limit}`
    : null;
}
