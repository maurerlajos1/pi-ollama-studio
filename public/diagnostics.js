export const DiagnosticSeverity = Object.freeze({ hint: 1, info: 2, warning: 4, error: 8 });

export function normalizeSeverity(value) {
  if (typeof value === 'number') {
    if (value >= 8) return 'error';
    if (value >= 4) return 'warning';
    if (value >= 2) return 'info';
    return 'hint';
  }
  const text = String(value || '').toLowerCase();
  if (text.includes('error') || text === 'fatal') return 'error';
  if (text.includes('warn')) return 'warning';
  if (text.includes('hint')) return 'hint';
  return 'info';
}

export function normalizeDiagnostic(input = {}, defaults = {}) {
  return {
    id: input.id || `${input.source || defaults.source || 'diagnostic'}:${input.path || ''}:${input.line || 0}:${input.column || 0}:${input.message || ''}`,
    source: input.source || defaults.source || 'diagnostic',
    severity: normalizeSeverity(input.severity ?? defaults.severity),
    path: String(input.path || defaults.path || '').replace(/\\/g, '/'),
    line: Math.max(1, Number(input.line || defaults.line || 1)),
    column: Math.max(1, Number(input.column || defaults.column || 1)),
    endLine: input.endLine ? Math.max(1, Number(input.endLine)) : null,
    endColumn: input.endColumn ? Math.max(1, Number(input.endColumn)) : null,
    message: String(input.message || defaults.message || 'Unknown problem'),
    code: input.code != null ? String(input.code) : '',
    details: input.details || null
  };
}

export function parseTextDiagnostics(text, { source = 'tool' } = {}) {
  const out = [];
  const patterns = [
    /^(.*?):(\d+):(\d+)(?:\s*[-:]\s*|\s+)(error|warning|warn|info)?\s*:?\s*(.+)$/i,
    /^(.*)\((\d+),(\d+)\):\s*(error|warning)\s*([A-Z]*\d+)?:?\s*(.+)$/i
  ];
  for (const raw of String(text || '').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    let match = patterns[0].exec(line);
    if (match) {
      out.push(normalizeDiagnostic({ source, path: match[1], line: match[2], column: match[3], severity: match[4] || 'error', message: match[5] }));
      continue;
    }
    match = patterns[1].exec(line);
    if (match) out.push(normalizeDiagnostic({ source, path: match[1], line: match[2], column: match[3], severity: match[4], code: match[5], message: match[6] }));
  }
  return out;
}

export function mergeDiagnostics(...groups) {
  const map = new Map();
  for (const item of groups.flat().filter(Boolean)) {
    const normalized = normalizeDiagnostic(item);
    map.set(normalized.id, normalized);
  }
  return [...map.values()].sort((a, b) => {
    const weight = { error: 0, warning: 1, info: 2, hint: 3 };
    return (weight[a.severity] - weight[b.severity]) || a.path.localeCompare(b.path) || a.line - b.line || a.column - b.column;
  });
}
