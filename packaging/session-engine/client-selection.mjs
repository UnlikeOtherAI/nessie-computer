import { createHash } from 'node:crypto'
import { posix } from 'node:path'

const hash = value => createHash('sha256').update(value).digest('hex')
const mobile = path => path.startsWith('apps/mobile/src/')

/**
 * Select original top-level mobile declarations and their lexical dependencies.
 * Function/type/initializer bodies are copied byte-for-byte; only import/export
 * lists are narrowed. Conservative identifier references can over-select, never
 * replace a selector. The pinned allowlist and normal strict compiler fail closed.
 * Shared packages are never sliced. This is a build transform, not a runtime loader.
 */
export const selectMobileClientSource = (ts, snapshot, manifest) => {
  const files = new Map()
  const queue = []
  const records = []
  const printer = ts.createPrinter({ newLine: ts.NewLineKind.LineFeed })
  const resolve = (specifier, importer) => {
    if (!specifier.startsWith('.')) {
      if (!/^(?:@t3tools\/(?:contracts|shared|client-runtime)(?:\/|$)|effect(?:\/|$))/u.test(specifier)) {
        throw new Error(`CLIENT_MOBILE_EXTERNAL_REFUSED:${specifier}`)
      }
      return specifier
    }
    const path = posix.normalize(posix.join(posix.dirname(importer), specifier))
    const resolved = [path, `${path}.ts`, `${path}/index.ts`].find(path => Object.hasOwn(manifest.files, path))
    if (!resolved || !mobile(resolved)) throw new Error(`CLIENT_MOBILE_SOURCE_UNREGISTERED:${path}`)
    return resolved
  }
  const bindingNames = name => ts.isIdentifier(name) ? [name.text]
    : name.elements.flatMap(element => ts.isOmittedExpression(element) ? [] : bindingNames(element.name))
  const namesOf = statement => {
    if (ts.isVariableStatement(statement)) return statement.declarationList.declarations
      .flatMap(declaration => bindingNames(declaration.name))
    return statement.name && ts.isIdentifier(statement.name) ? [statement.name.text] : []
  }
  const file = path => {
    if (files.has(path)) return files.get(path)
    const source = snapshot.read(path).toString('utf8')
    if (hash(source) !== manifest.files[path]) throw new Error(`CLIENT_MOBILE_SOURCE_HASH_MISMATCH:${path}`)
    const tree = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true)
    if (tree.parseDiagnostics.length) throw new Error(`CLIENT_MOBILE_SYNTAX_INVALID:${path}`)
    const symbols = new Map(), imports = new Map(), reexports = new Map()
    for (const statement of tree.statements) {
      if (ts.isImportDeclaration(statement)) {
        const clause = statement.importClause
        if (!clause) throw new Error('CLIENT_MOBILE_SIDE_EFFECT_IMPORT_REFUSED')
        if (clause.name) imports.set(clause.name.text, { statement, imported: 'default' })
        const bindings = clause.namedBindings
        if (bindings && ts.isNamespaceImport(bindings)) {
          imports.set(bindings.name.text, { statement, imported: '*' })
        } else for (const entry of bindings?.elements ?? []) {
          imports.set(entry.name.text, { statement, imported: (entry.propertyName ?? entry.name).text })
        }
      } else if (ts.isExportDeclaration(statement) && statement.moduleSpecifier) {
        if (!statement.exportClause || !ts.isNamedExports(statement.exportClause)) {
          throw new Error('CLIENT_MOBILE_WILDCARD_EXPORT_REFUSED')
        }
        for (const entry of statement.exportClause.elements) {
          reexports.set(entry.name.text, { statement, imported: (entry.propertyName ?? entry.name).text })
        }
      } else for (const name of namesOf(statement)) {
        const declarations = symbols.get(name) ?? []
        declarations.push(statement)
        symbols.set(name, declarations)
      }
    }
    const result = { path, source, tree, symbols, imports, reexports,
      needed: new Set(), statements: new Set() }
    files.set(path, result)
    return result
  }
  const requireSymbol = (path, name) => {
    const selected = file(path)
    if (selected.needed.has(name)) return
    if (!selected.symbols.has(name) && !selected.imports.has(name) && !selected.reexports.has(name)) {
      throw new Error(`CLIENT_MOBILE_SYMBOL_ABSENT:${path}:${name}`)
    }
    selected.needed.add(name)
    queue.push({ selected, name })
  }
  for (const [path, names] of Object.entries(manifest.entries)) for (const name of names) requireSymbol(path, name)
  while (queue.length) {
    const { selected, name } = queue.shift()
    const imported = selected.imports.get(name) ?? selected.reexports.get(name)
    if (imported) {
      const target = resolve(imported.statement.moduleSpecifier.text, selected.path)
      if (mobile(target)) {
        if (imported.imported === '*') throw new Error('CLIENT_MOBILE_NAMESPACE_IMPORT_REFUSED')
        requireSymbol(target, imported.imported)
      }
      continue
    }
    for (const statement of selected.symbols.get(name)) {
      if (selected.statements.has(statement)) continue
      selected.statements.add(statement)
      // Retain complete statements, including all declarations in a variable list.
      for (const declared of namesOf(statement)) selected.needed.add(declared)
      const visit = node => {
        if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
          throw new Error('CLIENT_MOBILE_DYNAMIC_IMPORT_REFUSED')
        }
        if (ts.isImportTypeNode(node)) throw new Error('CLIENT_MOBILE_IMPORT_TYPE_REFUSED')
        if (ts.isIdentifier(node) && (selected.symbols.has(node.text) || selected.imports.has(node.text)
          || selected.reexports.has(node.text))) requireSymbol(selected.path, node.text)
        ts.forEachChild(node, visit)
      }
      visit(statement)
    }
  }
  const output = new Map()
  for (const selected of files.values()) {
    const parts = []
    const ranges = []
    const moduleSpecifier = statement => {
      const target = resolve(statement.moduleSpecifier.text, selected.path)
      if (!mobile(target)) return statement.moduleSpecifier
      const relative = posix.relative(posix.dirname(selected.path), target)
      return ts.factory.createStringLiteral(relative.startsWith('.') ? relative : `./${relative}`)
    }
    for (const statement of selected.tree.statements) {
      if (ts.isImportDeclaration(statement)) {
        const clause = statement.importClause
        const name = clause.name && selected.needed.has(clause.name.text) ? clause.name : undefined
        const bindings = clause.namedBindings
        let named
        if (bindings && ts.isNamespaceImport(bindings)) {
          if (selected.needed.has(bindings.name.text)) named = bindings
        } else if (bindings) {
          const elements = bindings.elements.filter(entry => selected.needed.has(entry.name.text))
          if (elements.length) named = ts.factory.updateNamedImports(bindings, elements)
        }
        if (name || named) parts.push(printer.printNode(ts.EmitHint.Unspecified,
          ts.factory.updateImportDeclaration(statement, statement.modifiers,
            ts.factory.updateImportClause(clause, clause.isTypeOnly, name, named),
            moduleSpecifier(statement), statement.attributes), selected.tree))
      } else if (ts.isExportDeclaration(statement) && statement.moduleSpecifier) {
        const elements = statement.exportClause.elements.filter(entry => selected.needed.has(entry.name.text))
        if (elements.length) parts.push(printer.printNode(ts.EmitHint.Unspecified,
          ts.factory.updateExportDeclaration(statement, statement.modifiers, statement.isTypeOnly,
            ts.factory.updateNamedExports(statement.exportClause, elements), moduleSpecifier(statement),
            statement.attributes), selected.tree))
      } else if (selected.statements.has(statement)) {
        const start = statement.getFullStart(), end = statement.end
        const text = selected.source.slice(start, end)
        parts.push(text)
        ranges.push({ start, end, sha256: hash(text) })
      }
    }
    const bytes = Buffer.from(`${parts.join('\n')}\n`)
    output.set(selected.path, bytes)
    records.push({ path: selected.path, originalSha256: manifest.files[selected.path],
      selectedSha256: hash(bytes), names: [...selected.needed].sort(), originalRanges: ranges })
  }
  records.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0)
  return { records, snapshot: Object.freeze({
    identity: Object.freeze({ ...snapshot.identity, mobileClientSelectionSha256: hash(JSON.stringify(records)) }),
    files: Object.freeze([...new Set([...snapshot.files.filter(path => !mobile(path)), ...output.keys()])].sort()),
    read: path => output.has(path) ? Buffer.from(output.get(path))
      : mobile(path) ? (() => { throw new Error('CLIENT_MOBILE_UNSELECTED_SOURCE_REFUSED') })() : snapshot.read(path),
  }) }
}
