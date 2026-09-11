const placeholderPattern = /{{\s*([a-zA-Z0-9_]+)\s*}}/g;

export const substituteTemplate = (value: string, inputs: Record<string, string>): string =>
  value.replace(placeholderPattern, (_, key: string) => {
    if (!(key in inputs)) {
      throw new Error(`Missing template input: ${key}`);
    }
    return inputs[key];
  });

export const parameterizeValue = (value: string, inputs: Record<string, string>): string => {
  for (const [key, inputValue] of Object.entries(inputs)) {
    if (inputValue && value.includes(inputValue)) {
      return value.replaceAll(inputValue, `{{${key}}}`);
    }
  }
  return value;
};
