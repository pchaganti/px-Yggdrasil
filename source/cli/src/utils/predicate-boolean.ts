export const BOOLEAN_KEYS = new Set<string>(['all_of', 'any_of', 'not']);

export interface BooleanShape<Clause> {
  all_of?: Clause[];
  any_of?: Clause[];
  not?: Clause;
}

export function parsePredicateBoolean<Clause>(
  raw: Record<string, unknown>,
  key: string,
  ctx: string,
  parseClause: (raw: unknown, ctx: string) => Clause,
  ErrorClass: new (msg: string) => Error = Error,
): BooleanShape<Clause> {
  const val = raw[key];
  if (key === 'not') {
    return { not: parseClause(val, `${ctx}/not`) };
  }
  if (!Array.isArray(val)) {
    throw new ErrorClass(`${ctx}: '${key}' must be an array`);
  }
  if (val.length === 0) {
    throw new ErrorClass(`${ctx}: '${key}' array must not be empty`);
  }
  const items = val.map((v, i) => parseClause(v, `${ctx}/${key}[${i}]`));
  return key === 'all_of' ? { all_of: items } : { any_of: items };
}
