import Parser from 'web-tree-sitter';
import fs from 'fs/promises';
import path from 'path';
import crypto from 'crypto';
import { createRequire } from 'node:module';
import { ExtractionResult, LanguageStrategy, GraphNode, GraphEdge, RawExportEntry, RawImportEntry } from './types.js';

const require = createRequire(import.meta.url);

export async function initParser(projectRoot: string): Promise<Parser> {
  // §1.A: Core runtime must come from web-tree-sitter, not tree-sitter-wasms
  const corePath = require.resolve('web-tree-sitter/tree-sitter.wasm', {
    paths: [projectRoot, path.dirname(new URL(import.meta.url).pathname)],
  });
  const wasmBinary = await fs.readFile(corePath);
  await Parser.init({
    locateFile: () => corePath,
    wasmBinary: wasmBinary,
  });
  return new Parser();
}

export function resolveGrammarPath(projectRoot: string, grammarFile: string): string {
  // §1.A: Grammars come from tree-sitter-wasms/out/
  const grammarsPkg = require.resolve('tree-sitter-wasms/package.json', {
    paths: [projectRoot, path.dirname(new URL(import.meta.url).pathname)],
  });
  return path.join(path.dirname(grammarsPkg), 'out', grammarFile);
}

export class ParserRegistry {
  private static strategies = new Map<string, LanguageStrategy>();
  private static languages = new Map<string, any>();

  public static register(ext: string, strategy: LanguageStrategy) {
    ParserRegistry.strategies.set(ext, strategy);
  }

  public static get(ext: string): LanguageStrategy | undefined {
    return ParserRegistry.strategies.get(ext);
  }

  public static getSupportedExtensions(): string[] {
    return Array.from(ParserRegistry.strategies.keys());
  }

  public static setLanguage(ext: string, lang: any) {
    ParserRegistry.languages.set(ext, lang);
  }

  public static getLanguage(ext: string): any {
    return ParserRegistry.languages.get(ext);
  }

  public static getLoadedLanguageCount(): number {
    return ParserRegistry.languages.size;
  }
}

// §5: Use hash of full relative path to avoid collisions across files with same basename
function makeNodeId(filePath: string, name: string): string {
  const stem = crypto.createHash('sha256').update(filePath).digest('hex').slice(0, 8);
  return `${stem}_${name}`.toLowerCase().replace(/[^a-z0-9_]/g, '_');
}

export class TypeScriptStrategy implements LanguageStrategy {
  parse(sourceText: string, parser: Parser, filePath: string): ExtractionResult {
    const nodes: GraphNode[] = [];
    const edges: GraphEdge[] = [];
    const rawCalls: ExtractionResult['rawCalls'] = [];
    const rawExports: RawExportEntry[] = [];
    const rawImports: RawImportEntry[] = [];
    let defaultExportNodeId: string | undefined;

    let tree: Parser.Tree;
    try {
      tree = parser.parse(sourceText);
    } catch {
      return { nodes, edges, rawCalls, rawExports, rawImports };
    }

    if (!tree) return { nodes, edges, rawCalls, rawExports, rawImports };

    const rootNode = tree.rootNode;
    const fileNodeId = makeNodeId(filePath, path.basename(filePath, path.extname(filePath)));

    nodes.push({
      id: fileNodeId,
      label: path.basename(filePath),
      file_type: 'code',
      source_file: filePath,
    });

    // Track identifiers declared in this file for default export resolution
    const localDeclarations = new Map<string, string>();
    // Track import bindings for re-export detection
    const importBindings = new Map<string, { moduleSpecifier: string; importedName: string }>();

    const traverse = (node: Parser.SyntaxNode) => {
      // §2.A: Import declarations → RawImportEntry[]
      if (node.type === 'import_statement' || node.type === 'import_declaration') {
        const sourceNode = node.namedChildren.find(
          (c) => c.type === 'string' || c.type === 'string_fragment'
        );
        if (sourceNode) {
          const moduleSpecifier = sourceNode.text.replace(/['"]/g, '');
          const source_location = `L${node.startPosition.row + 1}`;
          const isTypeOnly = node.text.startsWith('import type');

          // Side-effect import: import './setup'
          const importClause = node.namedChildren.find((c) => c.type === 'import_clause');
          if (!importClause) {
            rawImports.push({ kind: 'side-effect', moduleSpecifier, source_location });
          } else {
            // namespace import: import * as ns from './a'
            const namespaceImport = importClause.namedChildren.find((c) => c.type === 'namespace_import');
            if (namespaceImport) {
              const localName = namespaceImport.namedChildren.find((c) => c.type === 'identifier')?.text || 'default';
              rawImports.push({
                kind: 'namespace',
                moduleSpecifier,
                localName,
                source_location,
              });
            } else {
              // default import or named imports
              const defaultImport = importClause.namedChildren.find((c) => c.type === 'identifier');
              if (defaultImport) {
                rawImports.push({
                  kind: isTypeOnly ? 'type-default' : 'default',
                  moduleSpecifier,
                  localName: defaultImport.text,
                  source_location,
                });
                // Track import binding for re-export detection
                if (!isTypeOnly) {
                  importBindings.set(defaultImport.text, { moduleSpecifier, importedName: 'default' });
                }
              }
              const namedImports = importClause.namedChildren.find((c) => c.type === 'import_specifiers' || c.type === 'named_imports');
              if (namedImports) {
                for (const specifier of namedImports.namedChildren) {
                  if (specifier.type === 'import_specifier') {
                    // §2.F: Use childForFieldName for specifiers
                    const importedNode = specifier.childForFieldName('name');
                    const aliasNode = specifier.childForFieldName('alias');
                    const importedName = importedNode?.text || '';
                    const localName = aliasNode?.text || importedName;
                    if (importedName) {
                      rawImports.push({
                        kind: isTypeOnly ? 'type-named' : 'named',
                        moduleSpecifier,
                        importedName,
                        localName,
                        source_location,
                      });
                      // Track import binding for re-export detection
                      if (!isTypeOnly) {
                        importBindings.set(localName, { moduleSpecifier, importedName });
                      }
                    }
                  }
                }
              }
            }
          }
        }
      }

      // §2.A: Export declarations — always emit rawExports
      if (node.type === 'export_statement') {
        const sourceNode = node.namedChildren.find(
          (c) => c.type === 'string' || c.type === 'string_fragment'
        );
        const sourceFile = sourceNode ? sourceNode.text.replace(/['"]/g, '') : undefined;
        const hasStar = node.text.includes('*');
        const isTypeOnly = node.text.startsWith('export type');

        if (hasStar && sourceFile) {
          rawExports.push({ symbol: '*', sourceFile, isStar: true, exportKind: isTypeOnly ? 'type' : 'value' });
        } else {
          const exportClause = node.namedChildren.find((c) => c.type === 'export_clause');
          if (exportClause) {
            for (const specifier of exportClause.namedChildren) {
              if (specifier.type === 'export_specifier') {
                // §2.F: Use childForFieldName for export specifiers
                const nameNode = specifier.childForFieldName('name');
                const aliasNode = specifier.childForFieldName('alias');
                const localName = nameNode?.text;
                if (localName) {
                  rawExports.push({
                    symbol: localName,
                    alias: aliasNode?.text,
                    sourceFile,
                    exportKind: isTypeOnly ? 'type' : 'value',
                  });
                }
              } else if (specifier.type === 'identifier') {
                rawExports.push({ symbol: specifier.text, sourceFile, exportKind: isTypeOnly ? 'type' : 'value' });
              }
            }
          } else {
            const decl = node.namedChildren.find(
              (c) =>
                c.type === 'function_declaration' ||
                c.type === 'class_declaration' ||
                c.type === 'lexical_declaration' ||
                c.type === 'variable_declaration'
            );
            if (decl) {
              const isDefault = node.text.includes('default');
              if (isDefault) {
                rawExports.push({ symbol: 'default', exportKind: isTypeOnly ? 'type' : 'value' });
              } else {
                const nameNode = decl.namedChildren.find(
                  (c) => c.type === 'identifier' || c.type === 'type_identifier'
                );
                if (nameNode) {
                  rawExports.push({ symbol: nameNode.text, exportKind: isTypeOnly ? 'type' : 'value' });
                }
              }
            } else if (node.text.includes('default')) {
              rawExports.push({ symbol: 'default', exportKind: isTypeOnly ? 'type' : 'value' });
            }
          }
        }
      }

      // §2.A: Code node emission — ALWAYS emit, even for exported declarations
      // Remove the v2 guard: `if (node.parent?.type !== 'export_statement')`
      if (
        node.type === 'function_declaration' ||
        node.type === 'method_definition' ||
        node.type === 'class_declaration'
      ) {
        const nameNode = node.namedChildren.find(
          (c) => c.type === 'identifier' || c.type === 'type_identifier'
        );
        if (nameNode) {
          const funcId = makeNodeId(filePath, nameNode.text);
          nodes.push({
            id: funcId,
            label: nameNode.text,
            file_type: 'code',
            source_file: filePath,
            source_location: `L${node.startPosition.row + 1}`,
          });
          edges.push({
            source: fileNodeId,
            target: funcId,
            relation: 'contains',
            type: 'PHYSICAL',
            score: 1.0,
            source_file: filePath,
          });
          localDeclarations.set(nameNode.text, funcId);

          // §2.A: Track defaultExportNodeId for named declarations
          if (node.parent?.type === 'export_statement' && node.parent.text.includes('default')) {
            defaultExportNodeId = funcId;
          }
        }
      }

      // §2.A: Arrow functions and anonymous callables on variable declarators
      if (
        node.type === 'lexical_declaration' ||
        node.type === 'variable_declaration'
      ) {
        for (const declarator of node.namedChildren) {
          if (declarator.type !== 'variable_declarator') continue;
          const nameNode = declarator.namedChildren.find((c) => c.type === 'identifier');
          if (!nameNode) continue;

          const init = declarator.namedChildren.find(
            (c) =>
              c.type === 'arrow_function' ||
              c.type === 'function' ||
              c.type === 'class'
          );

          // §2.A: Always emit a code node for the declarator name
          const funcId = makeNodeId(filePath, nameNode.text);
          const sourceLocation = `L${declarator.startPosition.row + 1}`;

          if (init) {
            // Named callable on a variable declarator
            nodes.push({
              id: funcId,
              label: nameNode.text,
              file_type: 'code',
              source_file: filePath,
              source_location: sourceLocation,
            });
            edges.push({
              source: fileNodeId,
              target: funcId,
              relation: 'contains',
              type: 'PHYSICAL',
              score: 1.0,
              source_file: filePath,
            });
          }
          localDeclarations.set(nameNode.text, funcId);

          // §2.A: Track defaultExportNodeId for variable declarators
          if (node.parent?.type === 'export_statement' && node.parent.text.includes('default')) {
            defaultExportNodeId = funcId;
          }
        }
      }

      // §2.A: Call expressions → rawCalls
      if (node.type === 'call_expression') {
        const funcNode = node.namedChildren[0];
        if (funcNode) {
          const callee = funcNode.text;
          const isMemberCall = funcNode.type === 'member_access_expression' || callee.includes('.');
          rawCalls.push({
            caller_nid: fileNodeId,
            callee,
            is_member_call: isMemberCall,
            source_location: `L${node.startPosition.row + 1}`,
          });
        }
      }

      for (const child of node.namedChildren) {
        traverse(child);
      }
    };

    traverse(rootNode);

    // §2.A: Second pass for default export identifier resolution
    // Handle `export default foo;` where foo is a local declaration
    if (!defaultExportNodeId) {
      // Look for export default with an identifier reference
      const findDefaultExportIdentifier = (node: Parser.SyntaxNode): string | null => {
        if (node.type === 'export_statement' && node.text.includes('default')) {
          // Check for identifier after 'default' keyword
          const defaultIdx = node.namedChildren.findIndex((c) => c.type === 'identifier' || c.type === 'type_identifier');
          if (defaultIdx >= 0) {
            return node.namedChildren[defaultIdx].text;
          }
          // Also check for identifier in the raw text after 'default'
          const match = node.text.match(/export\s+default\s+([a-zA-Z_$][\w$]*)\s*;/);
          if (match) {
            return match[1];
          }
        }
        for (const child of node.namedChildren) {
          const result = findDefaultExportIdentifier(child);
          if (result) return result;
        }
        return null;
      };

      const defaultIdent = findDefaultExportIdentifier(rootNode);
      if (defaultIdent) {
        const resolved = localDeclarations.get(defaultIdent);
        if (resolved) {
          defaultExportNodeId = resolved;
        } else {
          // §2.A: Check if it matches an import binding — emit re-export entry
          const importBinding = importBindings.get(defaultIdent);
          if (importBinding) {
            rawExports.push({
              symbol: importBinding.importedName,
              alias: 'default',
              sourceFile: importBinding.moduleSpecifier,
              exportKind: 'value',
            });
          }
          // §2.A: If unresolved, leave undefined — don't synthesize
        }
      }
    }

    // §2.A: For anonymous default exports, synthesize a node
    if (!defaultExportNodeId) {
      const hasAnonymousDefault = (node: Parser.SyntaxNode): boolean => {
        if (node.type === 'export_statement' && node.text.includes('default')) {
          const hasNamedDecl = node.namedChildren.some(
            (c) => c.type === 'function_declaration' || c.type === 'class_declaration'
          );
          const hasIdent = node.namedChildren.some((c) => c.type === 'identifier' || c.type === 'type_identifier');
          if (!hasNamedDecl && !hasIdent) return true;
        }
        for (const child of node.namedChildren) {
          if (hasAnonymousDefault(child)) return true;
        }
        return false;
      };

      if (hasAnonymousDefault(rootNode)) {
        const synthId = `${fileNodeId}:default`;
        nodes.push({
          id: synthId,
          label: 'default',
          file_type: 'code',
          source_file: filePath,
          source_location: 'L1',
        });
        edges.push({
          source: fileNodeId,
          target: synthId,
          relation: 'contains',
          type: 'PHYSICAL',
          score: 1.0,
          source_file: filePath,
        });
        defaultExportNodeId = synthId;
      }
    }

    return { nodes, edges, rawCalls, rawExports, rawImports, defaultExportNodeId };
  }
}

export class PythonStrategy implements LanguageStrategy {
  parse(sourceText: string, parser: Parser, filePath: string): ExtractionResult {
    const nodes: GraphNode[] = [];
    const edges: GraphEdge[] = [];
    const rawCalls: ExtractionResult['rawCalls'] = [];
    const rawExports: RawExportEntry[] = [];
    const rawImports: RawImportEntry[] = [];

    let tree: Parser.Tree;
    try {
      tree = parser.parse(sourceText);
    } catch {
      return { nodes, edges, rawCalls, rawExports, rawImports };
    }

    if (!tree) return { nodes, edges, rawCalls, rawExports, rawImports };

    const rootNode = tree.rootNode;
    const fileNodeId = makeNodeId(filePath, path.basename(filePath, path.extname(filePath)));

    nodes.push({
      id: fileNodeId,
      label: path.basename(filePath),
      file_type: 'code',
      source_file: filePath,
    });

    const traverse = (node: Parser.SyntaxNode) => {
      // §2.A Python mapping
      if (node.type === 'import_statement') {
        // `import x` or `import x as y` → namespace
        for (const child of node.namedChildren) {
          if (child.type === 'dotted_name' || child.type === 'aliased_import') {
            const nameNode = child.namedChildren.find((c) => c.type === 'dotted_name' || c.type === 'identifier');
            const aliasNode = child.namedChildren.find((c) => c.type === 'identifier' && c !== nameNode);
            const localName = aliasNode?.text || nameNode?.text;
            if (localName) {
              rawImports.push({
                kind: 'namespace',
                moduleSpecifier: nameNode?.text || '',
                localName,
                source_location: `L${node.startPosition.row + 1}`,
              });
            }
          }
        }
      }

      if (node.type === 'import_from_statement') {
        const moduleNode = node.namedChildren.find((c) => c.type === 'dotted_name' || c.type === 'module_name');
        const moduleSpecifier = moduleNode?.text?.replace(/\./g, '/') || '';
        const source_location = `L${node.startPosition.row + 1}`;

        if (node.text.includes('*')) {
          rawImports.push({ kind: 'side-effect', moduleSpecifier, source_location });
        } else {
          for (const child of node.namedChildren) {
            if (child.type === 'aliased_import' || child.type === 'dotted_name' || child.type === 'identifier') {
              const nameNode = child.type === 'aliased_import'
                ? child.namedChildren.find((c) => c.type === 'dotted_name' || c.type === 'identifier')
                : child;
              const aliasNode = child.type === 'aliased_import'
                ? child.namedChildren.find((c) => c.type === 'identifier' && c !== nameNode)
                : null;
              const importedName = nameNode?.text || '';
              const localName = aliasNode?.text || importedName;
              if (importedName) {
                rawImports.push({
                  kind: 'named',
                  moduleSpecifier,
                  importedName,
                  localName,
                  source_location,
                });
              }
            }
          }
        }
      }

      if (node.type === 'function_definition' || node.type === 'class_definition') {
        const nameNode = node.namedChildren.find((c) => c.type === 'identifier');
        if (nameNode) {
          const funcId = makeNodeId(filePath, nameNode.text);
          nodes.push({
            id: funcId,
            label: nameNode.text,
            file_type: 'code',
            source_file: filePath,
            source_location: `L${node.startPosition.row + 1}`,
          });
          edges.push({
            source: fileNodeId,
            target: funcId,
            relation: 'contains',
            type: 'PHYSICAL',
            score: 1.0,
            source_file: filePath,
          });
        }
      }

      if (node.type === 'call') {
        const funcNode = node.namedChildren[0];
        if (funcNode) {
          rawCalls.push({
            caller_nid: fileNodeId,
            callee: funcNode.text,
            is_member_call: funcNode.type === 'attribute' || funcNode.text.includes('.'),
            source_location: `L${node.startPosition.row + 1}`,
          });
        }
      }

      for (const child of node.namedChildren) {
        traverse(child);
      }
    };

    traverse(rootNode);
    return { nodes, edges, rawCalls, rawExports, rawImports };
  }
}

export class GenericStrategy implements LanguageStrategy {
  parse(sourceText: string, parser: Parser, filePath: string): ExtractionResult {
    const nodes: GraphNode[] = [];
    const edges: GraphEdge[] = [];
    const rawCalls: ExtractionResult['rawCalls'] = [];
    const rawExports: RawExportEntry[] = [];
    const rawImports: RawImportEntry[] = [];

    let tree: Parser.Tree;
    try {
      tree = parser.parse(sourceText);
    } catch {
      return { nodes, edges, rawCalls, rawExports, rawImports };
    }

    if (!tree) return { nodes, edges, rawCalls, rawExports, rawImports };

    const rootNode = tree.rootNode;
    const fileNodeId = makeNodeId(filePath, path.basename(filePath, path.extname(filePath)));

    nodes.push({
      id: fileNodeId,
      label: path.basename(filePath),
      file_type: 'code',
      source_file: filePath,
    });

    const traverse = (node: Parser.SyntaxNode) => {
      if (
        node.type.includes('function') ||
        node.type.includes('method') ||
        node.type.includes('class')
      ) {
        const nameChild = node.namedChildren.find(
          (c) =>
            c.type === 'identifier' ||
            c.type === 'name' ||
            c.type === 'type_identifier'
        );
        if (nameChild) {
          const id = makeNodeId(filePath, nameChild.text);
          nodes.push({
            id,
            label: nameChild.text,
            file_type: 'code',
            source_file: filePath,
            source_location: `L${node.startPosition.row + 1}`,
          });
          edges.push({
            source: fileNodeId,
            target: id,
            relation: 'contains',
            type: 'PHYSICAL',
            score: 1.0,
            source_file: filePath,
          });
        }
      }

      for (const child of node.namedChildren) {
        traverse(child);
      }
    };

    traverse(rootNode);
    return { nodes, edges, rawCalls, rawExports, rawImports };
  }
}

export function registerDefaultStrategies(): void {
  ParserRegistry.register('.ts', new TypeScriptStrategy());
  ParserRegistry.register('.tsx', new TypeScriptStrategy());
  ParserRegistry.register('.js', new TypeScriptStrategy());
  ParserRegistry.register('.jsx', new TypeScriptStrategy());
  ParserRegistry.register('.py', new PythonStrategy());
  ParserRegistry.register('.go', new GenericStrategy());
  ParserRegistry.register('.rs', new GenericStrategy());
  ParserRegistry.register('.java', new GenericStrategy());
  ParserRegistry.register('.c', new GenericStrategy());
  ParserRegistry.register('.cpp', new GenericStrategy());
  ParserRegistry.register('.h', new GenericStrategy());
}
