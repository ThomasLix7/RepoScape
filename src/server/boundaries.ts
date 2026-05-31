// Architectural Safety Radar: pure boundary-rule matching.
// Kept dependency-free and side-effect-free so a CLI gate (P2) can reuse it.

export interface BoundaryRule {
  from: string;
  to: string;
  // Exclusions applied to the `to` side: a match is suppressed if any `except` pattern
  // matches the imported file. Mirrors dependency-cruiser `to.pathNot`.
  except?: string[];
  // How `from`/`to`/`except` are interpreted. Hand-written rules are globs (default);
  // rules ejected from regex-based tools (dependency-cruiser) carry `regex`.
  pathKind?: 'glob' | 'regex';
  severity?: 'warn' | 'error';
  reason?: string;
}

export interface ArchitectureRules {
  boundaries: BoundaryRule[];
}

export interface BoundaryViolation {
  source: string; // node id
  target: string; // node id
  reason: string;
  score: number;
}

// Minimal glob: `**` spans path separators, `*` does not, `?` is one non-separator char.
export function globToRegExp(glob: string): RegExp {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*') {
      if (glob[i + 1] === '*') {
        re += '.*';
        i++;
      } else {
        re += '[^/]*';
      }
    } else if (c === '?') {
      re += '[^/]';
    } else if ('.+^${}()|[]\\/'.includes(c)) {
      re += '\\' + c;
    } else {
      re += c;
    }
  }
  return new RegExp('^' + re + '$');
}

// Compile one rule pattern. Globs are anchored (`^…$`) via globToRegExp; regex patterns
// are used verbatim and unanchored, matching dependency-cruiser's `.test()` semantics.
// Throws on an invalid regex — callers drop the offending rule rather than crash.
export function compileRulePattern(pattern: string, kind: 'glob' | 'regex'): RegExp {
  return kind === 'regex' ? new RegExp(pattern) : globToRegExp(pattern);
}

function severityScore(severity: 'warn' | 'error'): number {
  return severity === 'error' ? 0.9 : 0.5;
}

export function detectBoundaryViolations(
  edges: { source: string; target: string; fromFile: string; toFile: string }[],
  rules: ArchitectureRules
): BoundaryViolation[] {
  if (!rules.boundaries || rules.boundaries.length === 0) return [];

  const compiled = rules.boundaries.map((r) => {
    const kind = r.pathKind ?? 'glob';
    return {
      from: compileRulePattern(r.from, kind),
      to: compileRulePattern(r.to, kind),
      except: (r.except ?? []).map((e) => compileRulePattern(e, kind)),
      fromPattern: r.from,
      toPattern: r.to,
      severity: r.severity ?? 'error',
      reason: r.reason,
    };
  });

  const violations: BoundaryViolation[] = [];
  for (const e of edges) {
    for (const r of compiled) {
      if (
        r.from.test(e.fromFile) &&
        r.to.test(e.toFile) &&
        !r.except.some((ex) => ex.test(e.toFile))
      ) {
        violations.push({
          source: e.source,
          target: e.target,
          reason: r.reason || `Forbidden import: ${r.fromPattern} must not import ${r.toPattern}`,
          score: severityScore(r.severity),
        });
        break; // first matching rule wins
      }
    }
  }
  return violations;
}

// Validates the parsed rules file. Radar tolerates a missing/malformed file by
// returning empty boundaries rather than throwing.
export function parseArchitectureRules(raw: unknown): ArchitectureRules {
  if (!raw || typeof raw !== 'object') return { boundaries: [] };
  const boundaries = (raw as any).boundaries;
  if (!Array.isArray(boundaries)) return { boundaries: [] };

  const valid: BoundaryRule[] = [];
  for (const b of boundaries) {
    if (!b || typeof b !== 'object') continue;
    if (typeof b.from !== 'string' || typeof b.to !== 'string') continue;
    if (b.severity !== undefined && b.severity !== 'warn' && b.severity !== 'error') continue;
    if (b.reason !== undefined && typeof b.reason !== 'string') continue;

    let pathKind: 'glob' | 'regex' = 'glob';
    if (b.pathKind !== undefined) {
      if (b.pathKind !== 'glob' && b.pathKind !== 'regex') continue;
      pathKind = b.pathKind;
    }

    let except: string[] | undefined;
    if (b.except !== undefined) {
      if (typeof b.except === 'string') except = [b.except];
      else if (Array.isArray(b.except) && b.except.every((x: unknown) => typeof x === 'string')) except = b.except;
      else continue;
    }

    // Drop only the offending rule if any pattern fails to compile (esp. a bad regex).
    try {
      compileRulePattern(b.from, pathKind);
      compileRulePattern(b.to, pathKind);
      except?.forEach((e) => compileRulePattern(e, pathKind));
    } catch {
      continue;
    }

    valid.push({ from: b.from, to: b.to, except, pathKind: b.pathKind, severity: b.severity, reason: b.reason });
  }
  return { boundaries: valid };
}
