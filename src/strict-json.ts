/** Adapted from RoboRev's strict result reader: reject extra text and duplicate
 * keys (JSON.parse alone keeps the last key). Callers validate schema fields. */
export function parseStrictJson(raw: string): unknown {
  const parsed: unknown = JSON.parse(raw);
  const tokens = raw.match(/"(?:\\.|[^"\\])*"|[{}\[\]:,]|true|false|null|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/g)!;
  let position = 0;
  const visit = (): void => {
    const token = tokens[position++];
    if (token === '{') {
      const keys = new Set<string>();
      while (tokens[position] !== '}') {
        const key = JSON.parse(tokens[position++]!) as string;
        if (keys.has(key)) throw new Error(`Duplicate judge result key: ${key}`);
        keys.add(key); position++; visit();
        if (tokens[position] !== ',') break;
        position++;
      }
      position++;
    } else if (token === '[') {
      while (tokens[position] !== ']') {
        visit(); if (tokens[position] !== ',') break; position++;
      }
      position++;
    }
  };
  visit(); return parsed;
}
