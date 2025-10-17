export function renderTemplate(
  template: string,
  variables: Record<string, string | number | undefined>,
): string {
  if (!template) {
    return "";
  }

  return template.replace(/\{\{(\w+)\}\}/g, (match, key) => {
    const value = variables[key];
    if (value === undefined || value === null) {
      return "";
    }
    return String(value);
  });
}
