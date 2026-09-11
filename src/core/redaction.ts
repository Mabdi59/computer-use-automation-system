const secretPatterns = [
  /(bearer\s+)[a-z0-9._-]+/gi,
  /(api[_-]?key\s*[=:]\s*)[^\s,]+/gi,
  /(token\s*[=:]\s*)[^\s,]+/gi,
  /(cookie\s*[=:]\s*)[^\s,]+/gi,
];

const sensitiveFieldPattern = /(password|payment|ssn|social security|cookie|token)/i;

export const redactText = (value: string, extraPatterns: RegExp[] = []): string => {
  let output = value;
  for (const pattern of [...secretPatterns, ...extraPatterns]) {
    output = output.replace(pattern, '$1[REDACTED]');
  }
  return output;
};

export const redactFieldValue = (fieldName: string, value: string): string =>
  sensitiveFieldPattern.test(fieldName) ? '[REDACTED]' : redactText(value);

export const sanitizeObject = <T>(value: T): T => {
  if (typeof value === 'string') {
    return redactText(value) as T;
  }
  if (Array.isArray(value)) {
    return value.map((entry) => sanitizeObject(entry)) as T;
  }
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, entry]) => {
        if (typeof entry === 'string') {
          return [key, redactFieldValue(key, entry)];
        }
        return [key, sanitizeObject(entry)];
      })
    ) as T;
  }
  return value;
};
