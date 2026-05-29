import { describe, it, expect } from 'vitest';
import { validateCognitiveChunk } from '../server/security.js';

describe('validateCognitiveChunk', () => {
  it('should validate a correct chunk', () => {
    const chunk = {
      nodes: [
        { id: 'test_node', label: 'Test', file_type: 'code', source_file: 'src/test.ts' },
      ],
      edges: [
        { source: 'a', target: 'b', relation: 'imports', type: 'PHYSICAL', score: 1.0 },
      ],
    };
    expect(validateCognitiveChunk(chunk)).toBe(true);
  });

  it('should reject null input', () => {
    expect(validateCognitiveChunk(null)).toBe(false);
  });

  it('should reject missing nodes array', () => {
    expect(validateCognitiveChunk({ edges: [] })).toBe(false);
  });

  it('should reject missing edges array', () => {
    expect(validateCognitiveChunk({ nodes: [] })).toBe(false);
  });

  it('should reject node with empty id', () => {
    const chunk = {
      nodes: [{ id: '', label: 'Test', file_type: 'code', source_file: 'src/test.ts' }],
      edges: [],
    };
    expect(validateCognitiveChunk(chunk)).toBe(false);
  });

  it('should reject node with invalid file_type', () => {
    const chunk = {
      nodes: [{ id: 'a', label: 'Test', file_type: 'invalid', source_file: 'src/test.ts' }],
      edges: [],
    };
    expect(validateCognitiveChunk(chunk)).toBe(false);
  });

  it('should reject node with path traversal', () => {
    const chunk = {
      nodes: [{ id: 'a', label: 'Test', file_type: 'code', source_file: '../etc/passwd' }],
      edges: [],
    };
    expect(validateCognitiveChunk(chunk)).toBe(false);
  });

  it('should reject node with absolute path', () => {
    const chunk = {
      nodes: [{ id: 'a', label: 'Test', file_type: 'code', source_file: '/etc/passwd' }],
      edges: [],
    };
    expect(validateCognitiveChunk(chunk)).toBe(false);
  });

  it('should reject edge with invalid type', () => {
    const chunk = {
      nodes: [{ id: 'a', label: 'Test', file_type: 'code', source_file: 'src/test.ts' }],
      edges: [{ source: 'a', target: 'b', relation: 'x', type: 'INVALID', score: 0.5 }],
    };
    expect(validateCognitiveChunk(chunk)).toBe(false);
  });

  it('should reject edge with score out of range', () => {
    const chunk = {
      nodes: [{ id: 'a', label: 'Test', file_type: 'code', source_file: 'src/test.ts' }],
      edges: [{ source: 'a', target: 'b', relation: 'x', type: 'PHYSICAL', score: 1.5 }],
    };
    expect(validateCognitiveChunk(chunk)).toBe(false);
  });

  it('should reject edge with negative score', () => {
    const chunk = {
      nodes: [{ id: 'a', label: 'Test', file_type: 'code', source_file: 'src/test.ts' }],
      edges: [{ source: 'a', target: 'b', relation: 'x', type: 'PHYSICAL', score: -0.1 }],
    };
    expect(validateCognitiveChunk(chunk)).toBe(false);
  });
});
