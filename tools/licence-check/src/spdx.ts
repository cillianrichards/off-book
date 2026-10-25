// SPDX licence expressions: just enough to decide whether a declared licence is on the allowlist.
// Grammar (SPDX 2.3, annex D): `OR` binds loosest, then `AND`, then `WITH`; parentheses group.

export type Expression =
  | { readonly kind: 'licence'; readonly id: string }
  | { readonly kind: 'with'; readonly id: string; readonly exception: string }
  | { readonly kind: 'and'; readonly left: Expression; readonly right: Expression }
  | { readonly kind: 'or'; readonly left: Expression; readonly right: Expression };

export class SpdxError extends Error {}

// GNU identifiers that SPDX has deprecated in favour of explicit `-only` and `-or-later` forms.
const deprecatedGnu = /^(A?GPL|LGPL)-(\d\.\d)$/i;

/** Canonical form of a licence identifier: deprecated GNU forms and a trailing `+` made explicit. */
export function canonicalId(raw: string): string {
  const orLater = raw.endsWith('+');
  const id = orLater ? raw.slice(0, -1) : raw;
  const gnu = deprecatedGnu.exec(id);
  if (gnu) return `${gnu[1]}-${gnu[2]}-${orLater ? 'or-later' : 'only'}`;
  return orLater ? `${id}+` : id;
}

const idPattern = /^[A-Za-z0-9.:-]+\+?$/;

function tokenise(text: string): string[] {
  return text
    .replaceAll('(', ' ( ')
    .replaceAll(')', ' ) ')
    .split(/\s+/)
    .filter(t => t.length > 0);
}

export function parse(text: string): Expression {
  const tokens = tokenise(text);
  let position = 0;

  const peek = (): string | undefined => tokens[position];
  const isOperator = (token: string | undefined, operator: string): boolean =>
    token !== undefined && token.toUpperCase() === operator;

  function identifier(what: string): string {
    const token = tokens[position];
    if (
      token === undefined ||
      !idPattern.test(token) ||
      ['AND', 'OR', 'WITH'].includes(token.toUpperCase())
    ) {
      throw new SpdxError(`expected ${what} at token ${position + 1} of "${text}"`);
    }
    position += 1;
    return token;
  }

  function primary(): Expression {
    if (peek() === '(') {
      position += 1;
      const inner = or();
      if (peek() !== ')') throw new SpdxError(`unclosed parenthesis in "${text}"`);
      position += 1;
      return inner;
    }
    const id = canonicalId(identifier('a licence identifier'));
    if (isOperator(peek(), 'WITH')) {
      position += 1;
      return { kind: 'with', id, exception: identifier('an exception identifier') };
    }
    return { kind: 'licence', id };
  }

  function and(): Expression {
    let left = primary();
    while (isOperator(peek(), 'AND')) {
      position += 1;
      left = { kind: 'and', left, right: primary() };
    }
    return left;
  }

  function or(): Expression {
    let left = and();
    while (isOperator(peek(), 'OR')) {
      position += 1;
      left = { kind: 'or', left, right: and() };
    }
    return left;
  }

  if (tokens.length === 0) throw new SpdxError('empty licence expression');
  const expression = or();
  if (position !== tokens.length) throw new SpdxError(`unexpected "${tokens[position]}" in "${text}"`);
  return expression;
}

/**
 * Whether the expression can be satisfied using only allowed licences.
 * `allowed` holds canonical identifiers in lower case, since SPDX identifiers are case-insensitive.
 * An exception (`WITH`) only grants extra permissions, so it is acceptable when its licence is.
 * `X+` means version X or any later one, so it is acceptable when X is.
 */
export function isAllowed(expression: Expression, allowed: ReadonlySet<string>): boolean {
  if (expression.kind === 'and') {
    return isAllowed(expression.left, allowed) && isAllowed(expression.right, allowed);
  }
  if (expression.kind === 'or') {
    return isAllowed(expression.left, allowed) || isAllowed(expression.right, allowed);
  }
  const id = expression.id.toLowerCase();
  return allowed.has(id) || (id.endsWith('+') && allowed.has(id.slice(0, -1)));
}
