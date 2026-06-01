import Parser from 'web-tree-sitter';
import fs from 'fs/promises';
import path from 'path';
import { createRequire } from 'node:module';
import { ExtractionResult, LanguageStrategy, GraphNode, GraphEdge, RawExportEntry, RawImportEntry } from './types.js';

const require = createRequire(import.meta.url);

export async function initParser(projectRoot: string): Promise<Parser> {
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

// Deterministic, agent-reproducible node IDs
function normSeg(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
}

function makeFileId(relPath: string): string {
  return relPath
    .split('/')
    .map((seg) => seg.toLowerCase().replace(/[^a-z0-9.]+/g, '_').replace(/^[._]+|[._]+$/g, ''))
    .filter(Boolean)
    .join('_');
}

const ID_CONTAINER_TYPES = new Set([
  'class_declaration',
  'class_definition',
  'class',
  'interface_declaration',
  'internal_module',
  'module',
  'namespace_declaration',
]);

// Collect enclosing class/namespace chain
function enclosingQualifier(node: Parser.SyntaxNode): string[] {
  const parts: string[] = [];
  let cur = node.parent;
  while (cur) {
    if (ID_CONTAINER_TYPES.has(cur.type)) {
      const nameNode = cur.namedChildren.find(
        (c) => c.type === 'identifier' || c.type === 'type_identifier'
      );
      if (nameNode) parts.unshift(nameNode.text);
    }
    cur = cur.parent;
  }
  return parts;
}

function makeNodeId(relPath: string, qualifiedName: string): string {
  const sym = qualifiedName.split('.').map(normSeg).filter(Boolean).join('.');
  return sym ? `${makeFileId(relPath)}:${sym}` : makeFileId(relPath);
}

function hashText(text: string): string {
  let h = 5381;
  for (let i = 0; i < text.length; i++) h = ((h << 5) + h + text.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}

// Generate qualified symbol IDs with duplicate suffixes
function makeSymbolIder(relPath: string): (node: Parser.SyntaxNode, name: string) => string {
  const seen = new Map<string, number>();
  return (node, name) => {
    const base = makeNodeId(relPath, [...enclosingQualifier(node), name].join('.'));
    const count = (seen.get(base) ?? 0) + 1;
    seen.set(base, count);
    return count === 1 ? base : `${base}~${count}`;
  };
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
    const fileNodeId = makeFileId(filePath);
    const symId = makeSymbolIder(filePath);

    nodes.push({
      id: fileNodeId,
      label: path.basename(filePath),
      file_type: 'code',
      source_file: filePath,
    });

    const localDeclarations = new Map<string, string>();
    const importBindings = new Map<string, { moduleSpecifier: string; importedName: string }>();

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
      if (node.type === 'import_statement' || node.type === 'import_declaration') {
        const sourceNode = node.namedChildren.find(
          (c) => c.type === 'string' || c.type === 'string_fragment'
        );
        if (sourceNode) {
          const moduleSpecifier = sourceNode.text.replace(/['"]/g, '');
          const source_location = `L${node.startPosition.row + 1}`;
          const isTypeOnly = node.text.startsWith('import type');

          const importClause = node.namedChildren.find((c) => c.type === 'import_clause');
          if (!importClause) {
            rawImports.push({ kind: 'side-effect', moduleSpecifier, source_location });
          } else {
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
              const defaultImport = importClause.namedChildren.find((c) => c.type === 'identifier');
              if (defaultImport) {
                rawImports.push({
                  kind: isTypeOnly ? 'type-default' : 'default',
                  moduleSpecifier,
                  localName: defaultImport.text,
                  source_location,
                });
                if (!isTypeOnly) {
                  importBindings.set(defaultImport.text, { moduleSpecifier, importedName: 'default' });
                }
              }
              const namedImports = importClause.namedChildren.find((c) => c.type === 'import_specifiers' || c.type === 'named_imports');
              if (namedImports) {
                const stmtIsTypeOnly = isTypeOnly;
                for (const specifier of namedImports.namedChildren) {
                  if (specifier.type === 'import_specifier') {
                    const importedNode = specifier.childForFieldName('name');
                    const aliasNode = specifier.childForFieldName('alias');
                    const importedName = importedNode?.text || '';
                    const localName = aliasNode?.text || importedName;
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

      if (node.type === 'export_statement') {
        const sourceNode = node.namedChildren.find(
          (c) => c.type === 'string' || c.type === 'string_fragment'
        );
        const sourceFile = sourceNode ? sourceNode.text.replace(/['"]/g, '') : undefined;
        const hasStar = hasStarSpecifier(node);
        const isTypeOnly = isTypeOnlyExport(node);

        if (hasStar && sourceFile) {
          rawExports.push({ symbol: '*', sourceFile, isStar: true, exportKind: isTypeOnly ? 'type' : 'value' });
        } else {
          const exportClause = node.namedChildren.find((c) => c.type === 'export_clause');
          if (exportClause) {
            const stmtIsTypeOnly = isTypeOnly;
            for (const specifier of exportClause.namedChildren) {
              if (specifier.type === 'export_specifier') {
                const nameNode = specifier.childForFieldName('name');
                const aliasNode = specifier.childForFieldName('alias');
                const localName = nameNode?.text;
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

      if (
        node.type === 'function_declaration' ||
        node.type === 'method_definition' ||
        node.type === 'class_declaration'
      ) {
        // Support property_identifier for class methods
        const nameNode = node.namedChildren.find(
          (c) =>
            c.type === 'identifier' ||
            c.type === 'type_identifier' ||
            c.type === 'property_identifier'
        );
        // Exclude constructors
        const isConstructor = node.type === 'method_definition' && nameNode?.text === 'constructor';
        if (nameNode && !isConstructor) {
          const funcId = symId(node, nameNode.text);
          nodes.push({
            id: funcId,
            label: nameNode.text,
            file_type: 'code',
            source_file: filePath,
            source_location: `L${node.startPosition.row + 1}`,
            contentHash: hashText(node.text),
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

          if (node.parent?.type === 'export_statement' && isDefaultExport(node.parent)) {
            defaultExportNodeId = funcId;
          }
        }
      }

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

          const funcId = symId(declarator, nameNode.text);
          const sourceLocation = `L${declarator.startPosition.row + 1}`;

          if (init) {
            nodes.push({
              id: funcId,
              label: nameNode.text,
              file_type: 'code',
              source_file: filePath,
              source_location: sourceLocation,
              contentHash: hashText(declarator.text),
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

          if (node.parent?.type === 'export_statement' && isDefaultExport(node.parent)) {
            defaultExportNodeId = funcId;
          }
        }
      }

      if (node.type === 'call_expression') {
        const funcNode = node.namedChildren[0];
        if (funcNode) {
          const callee = funcNode.text;
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

    if (!defaultExportNodeId) {
      const findDefaultExportIdentifier = (node: Parser.SyntaxNode): string | null => {
        if (node.type === 'export_statement' && isDefaultExport(node)) {
          const value = node.childForFieldName('value');
          if (value && (value.type === 'identifier' || value.type === 'type_identifier')) {
            return value.text;
          }
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
          const importBinding = importBindings.get(defaultIdent);
          if (importBinding) {
            rawExports.push({
              symbol: importBinding.importedName,
              alias: 'default',
              sourceFile: importBinding.moduleSpecifier,
              exportKind: 'value',
            });
          }
          diagnostics.push(`default-export-unresolved-identifier: ${defaultIdent} in ${filePath}`);
        }
      }
    }

    if (!defaultExportNodeId) {
      const hasAnonymousDefault = (node: Parser.SyntaxNode): boolean => {
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
    const fileNodeId = makeFileId(filePath);
    const symId = makeSymbolIder(filePath);

    nodes.push({
      id: fileNodeId,
      label: path.basename(filePath),
      file_type: 'code',
      source_file: filePath,
    });

    const traverse = (node: Parser.SyntaxNode) => {
      if (node.type === 'import_statement') {
        for (const child of node.namedChildren) {
          if (child.type === 'dotted_name' || child.type === 'aliased_import') {
            const nameNode =
              child.type === 'aliased_import'
                ? child.namedChildren.find((c) => c.type === 'dotted_name')
                : child;
            const aliasNode =
              child.type === 'aliased_import'
                ? child.namedChildren.find((c) => c.type === 'identifier')
                : null;
            const moduleSpecifier = nameNode?.text ?? '';
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

        const hasWildcard = node.namedChildren.some((c) => c.type === 'wildcard_import');
        if (hasWildcard) {
          rawImports.push({ kind: 'side-effect', moduleSpecifier, source_location });
        } else {
          for (const child of node.namedChildren) {
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
          const funcId = symId(node, nameNode.text);
          nodes.push({
            id: funcId,
            label: nameNode.text,
            file_type: 'code',
            source_file: filePath,
            source_location: `L${node.startPosition.row + 1}`,
            contentHash: hashText(node.text),
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
    const fileNodeId = makeFileId(filePath);
    const symId = makeSymbolIder(filePath);

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
          const id = symId(node, nameChild.text);
          nodes.push({
            id,
            label: nameChild.text,
            file_type: 'code',
            source_file: filePath,
            source_location: `L${node.startPosition.row + 1}`,
            contentHash: hashText(node.text),
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
