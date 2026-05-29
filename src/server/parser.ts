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
    paths: [projectRoot, process.cwd(), path.dirname(new URL(import.meta.url).pathname)],
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
    paths: [projectRoot, process.cwd(), path.dirname(new URL(import.meta.url).pathname)],
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
    const diagnostics: string[] = [];

    let tree: Parser.Tree;
    try {
      tree = parser.parse(sourceText);
    } catch {
      return { nodes, edges, rawCalls, rawExports, rawImports, diagnostics };
    }

    if (!tree) return { nodes, edges, rawCalls, rawExports, rawImports, diagnostics };

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

    // §2.F: Tree-sitter field helpers — never use text.includes as a classifier
    // Note: keywords like 'default', '*', 'type' are anonymous tokens (isNamed=false)
    // and only appear in node.children, NOT in node.namedChildren.
    const isDefaultExport = (node: Parser.SyntaxNode): boolean => {
      return node.children.some((c) => c.type === 'default' && !c.isNamed);
    };
    const hasStarSpecifier = (node: Parser.SyntaxNode): boolean => {
      return node.children.some((c) => c.type === '*' && !c.isNamed);
    };
    const isTypeOnlyExport = (node: Parser.SyntaxNode): boolean => {
      return node.children.some((c) => c.type === 'type' && !c.isNamed);
    };

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
                const stmtIsTypeOnly = isTypeOnly; // outer `import type { … }`
                for (const specifier of namedImports.namedChildren) {
                  if (specifier.type === 'import_specifier') {
                    // §2.F: Use childForFieldName for specifiers
                    const importedNode = specifier.childForFieldName('name');
                    const aliasNode = specifier.childForFieldName('alias');
                    const importedName = importedNode?.text || '';
                    const localName = aliasNode?.text || importedName;
                    // §2.F: Per-specifier type keyword check
                    const specIsTypeOnly = stmtIsTypeOnly ||
                      specifier.children.some((c) => c.type === 'type' && !c.isNamed);
                    if (importedName) {
                      rawImports.push({
                        kind: specIsTypeOnly ? 'type-named' : 'named',
                        moduleSpecifier,
                        importedName,
                        localName,
                        source_location,
                      });
                      // Track import binding for re-export detection (value imports only)
                      if (!specIsTypeOnly) {
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
        // §2.F: Use tree-sitter structure, not text.includes
        const hasStar = hasStarSpecifier(node);
        const isTypeOnly = isTypeOnlyExport(node);

        if (hasStar && sourceFile) {
          rawExports.push({ symbol: '*', sourceFile, isStar: true, exportKind: isTypeOnly ? 'type' : 'value' });
        } else {
          const exportClause = node.namedChildren.find((c) => c.type === 'export_clause');
          if (exportClause) {
            const stmtIsTypeOnly = isTypeOnly; // outer `export type { … }`
            for (const specifier of exportClause.namedChildren) {
              if (specifier.type === 'export_specifier') {
                // §2.F: Use childForFieldName for export specifiers
                const nameNode = specifier.childForFieldName('name');
                const aliasNode = specifier.childForFieldName('alias');
                const localName = nameNode?.text;
                // §2.F: Per-specifier type keyword check
                const specIsTypeOnly = stmtIsTypeOnly ||
                  specifier.children.some((c) => c.type === 'type' && !c.isNamed);
                if (localName) {
                  rawExports.push({
                    symbol: localName,
                    alias: aliasNode?.text,
                    sourceFile,
                    exportKind: specIsTypeOnly ? 'type' : 'value',
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
              // §2.F: Use tree-sitter structure to detect 'default' keyword
              if (isDefaultExport(node)) {
                rawExports.push({ symbol: 'default', exportKind: isTypeOnly ? 'type' : 'value' });
              } else {
                const nameNode = decl.namedChildren.find(
                  (c) => c.type === 'identifier' || c.type === 'type_identifier'
                );
                if (nameNode) {
                  rawExports.push({ symbol: nameNode.text, exportKind: isTypeOnly ? 'type' : 'value' });
                }
              }
            } else if (isDefaultExport(node)) {
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
          // §2.F: Use tree-sitter structure, not text.includes
          if (node.parent?.type === 'export_statement' && isDefaultExport(node.parent)) {
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
          // §2.F: Use tree-sitter structure, not text.includes
          if (node.parent?.type === 'export_statement' && isDefaultExport(node.parent)) {
            defaultExportNodeId = funcId;
          }
        }
      }

      // §2.A: Call expressions → rawCalls
      if (node.type === 'call_expression') {
        const funcNode = node.namedChildren[0];
        if (funcNode) {
          const callee = funcNode.text;
          // §2.F: Use tree-sitter node type, not text.includes('.')
          const isMemberCall =
            funcNode.type === 'member_expression' ||
            funcNode.type === 'subscript_expression';
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
      // §2.F: Use tree-sitter fields, not regex/text matching
      const findDefaultExportIdentifier = (node: Parser.SyntaxNode): string | null => {
        if (node.type === 'export_statement' && isDefaultExport(node)) {
          // Use childForFieldName('value') to get the exported expression
          const value = node.childForFieldName('value');
          if (value && (value.type === 'identifier' || value.type === 'type_identifier')) {
            return value.text;
          }
          // Fallback: walk namedChildren for identifier after 'default'
          for (const child of node.namedChildren) {
            if ((child.type === 'identifier' || child.type === 'type_identifier') && child.text !== 'default') {
              return child.text;
            }
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
          // §2.A: Surface diagnostic for the compiler to log
          diagnostics.push(`default-export-unresolved-identifier: ${defaultIdent} in ${filePath}`);
        }
      }
    }

    // §2.A: For anonymous default exports, synthesize a node
    if (!defaultExportNodeId) {
      const hasAnonymousDefault = (node: Parser.SyntaxNode): boolean => {
        // §2.F: Use tree-sitter structure, not text.includes
        if (node.type === 'export_statement' && isDefaultExport(node)) {
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

    return { nodes, edges, rawCalls, rawExports, rawImports, defaultExportNodeId, diagnostics };
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
            // TODO(v3.1): Python cross-module resolution. moduleSpecifier here is the
            // raw dotted name (e.g. "x.y"); the resolver does not yet handle it.
            const nameNode =
              child.type === 'aliased_import'
                ? child.namedChildren.find((c) => c.type === 'dotted_name')
                : child;
            const aliasNode =
              child.type === 'aliased_import'
                ? child.namedChildren.find((c) => c.type === 'identifier')
                : null;
            const moduleSpecifier = nameNode?.text ?? '';
            // `import x.y` binds the top-level name `x`, not `x.y`.
            const localName =
              aliasNode?.text ?? moduleSpecifier.split('.')[0];
            if (moduleSpecifier && localName) {
              rawImports.push({
                kind: 'namespace',
                moduleSpecifier,
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

        // §2.F: Use tree-sitter structure to detect wildcard import
        const hasWildcard = node.namedChildren.some((c) => c.type === 'wildcard_import');
        if (hasWildcard) {
          rawImports.push({ kind: 'side-effect', moduleSpecifier, source_location });
        } else {
          for (const child of node.namedChildren) {
            // Skip the module specifier node — it's the "from x" part, not an imported name
            if (child === moduleNode) continue;
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
