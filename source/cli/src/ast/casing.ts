/**
 * Naming convention predicates for common casing styles.
 */
export const casing = {
  /** PascalCase: starts with uppercase letter, only alphanumeric characters. */
  pascal: (name: string) => /^[A-Z][A-Za-z0-9]*$/.test(name),
  /** camelCase: starts with lowercase letter, only alphanumeric characters. */
  camel: (name: string) => /^[a-z][A-Za-z0-9]*$/.test(name),
  /** UPPER_SNAKE_CASE: starts with uppercase letter, only uppercase letters, digits, underscores. */
  upperSnake: (name: string) => /^[A-Z][A-Z0-9_]*$/.test(name),
  /** kebab-case: starts with lowercase letter, only lowercase letters, digits, hyphens. */
  kebab: (name: string) => /^[a-z][a-z0-9-]*$/.test(name),
};
