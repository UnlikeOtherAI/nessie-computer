import { createHash } from 'node:crypto'

// These original inferred declarations exceed TypeScript's serialization limit.
// Name their existing constructor arguments, never their decoded DTO shapes.
const targets = new Map([
  ['environmentHttp.ts', ['EnvironmentOrchestrationHttpApi']],
  ['guestStream.ts', ['GuestStreamEvent']],
  ['orchestrationV2.ts', ['OrchestrationV2ThreadStreamItem', 'OrchestrationV2RpcSchemas']],
  ['rpc.ts', ['WsRpcGroup']],
])
const hash = bytes => createHash('sha256').update(bytes).digest('hex')

/** Producer-only annotations. Runtime bundling still reads the unmodified snapshot. */
export const nameContractTypes = (ts, program, sourcePath) => {
  const checker = program.getTypeChecker()
  const printer = ts.createPrinter()
  const sources = new Map()
  const checks = new Map()
  const records = []
  for (const source of program.getSourceFiles()) {
    const path = sourcePath(source.fileName)
    const names = targets.get(path?.replace('packages/contracts/src/', ''))
    if (!names) continue
    const print = node => printer.printNode(ts.EmitHint.Unspecified, node, source)
    const edits = []
    const assertions = []
    for (const statement of source.statements) {
      const declarations = ts.isVariableStatement(statement) ? statement.declarationList.declarations : [statement]
      for (const declaration of declarations) {
        if (!ts.isVariableDeclaration(declaration) && !ts.isClassDeclaration(declaration)) continue
        if (!names.includes(declaration.name?.text)) continue
        const expression = ts.isClassDeclaration(declaration)
          ? declaration.heritageClauses?.[0]?.types[0]?.expression : declaration.initializer
        if (!expression || declaration.type) throw new Error('Original contract declaration shape changed.')
        const references = new Map()
        const remember = node => {
          if (ts.isIdentifier(node) || ts.isPropertyAccessExpression(node)) {
            const symbol = checker.getSymbolAtLocation(node)
            const qualifiedName = ts.isIdentifier(node) && ts.isPropertyAccessExpression(node.parent)
              && node.parent.name === node
            const local = symbol?.declarations?.some(item => item.getSourceFile() === source
              && item.pos >= expression.pos && item.end <= expression.end)
            const valueFlags = ts.SymbolFlags.Variable | ts.SymbolFlags.Class | ts.SymbolFlags.Function
              | ts.SymbolFlags.ValueModule | ts.SymbolFlags.Alias
            if (symbol && symbol.flags & valueFlags && !qualifiedName && !local) {
              const type = checker.getTypeAtLocation(node)
              if (!(type.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) && !references.has(type)) {
                references.set(type, `typeof ${node.getText(source)}`)
              }
            }
          }
          ts.forEachChild(node, remember)
        }
        remember(expression)
        const root = checker.getTypeAtLocation(expression)
        references.delete(root)
        const active = new Set()
        const render = type => {
          if (references.has(type)) return references.get(type)
          if (active.has(type)) throw new Error('Unnamed recursive contract type refused.')
          active.add(type)
          try {
            if (type.isUnionOrIntersection()) {
              return `(${type.types.map(render).join(type.isUnion() ? ' | ' : ' & ')})`
            }
            if (checker.isTupleType(type)) {
              const elements = checker.getTypeArguments(type).map((item, index) => {
                const flag = type.target.elementFlags[index]
                if (flag !== ts.ElementFlags.Required) throw new Error('Non-required contract tuple refused.')
                return render(item)
              })
              return `${type.target.readonly ? 'readonly ' : ''}[${elements.join(', ')}]`
            }
            const symbol = type.aliasSymbol ?? (type.objectFlags & ts.ObjectFlags.Reference ? type.symbol : undefined)
            if (symbol) {
              const name = checker.symbolToEntityName(symbol, ts.SymbolFlags.Type, declaration,
                ts.NodeBuilderFlags.UseFullyQualifiedType)
              if (!name) throw new Error('Original constructor name is inaccessible.')
              const args = type.aliasTypeArguments ?? checker.getTypeArguments(type)
              return `${print(name)}${args.length ? `<${args.map(render).join(', ')}>` : ''}`
            }
            if (type.flags & ts.TypeFlags.Object && type.objectFlags & ts.ObjectFlags.Anonymous
              && !type.getCallSignatures().length && !type.getConstructSignatures().length
              && !checker.getIndexInfosOfType(type).length) {
              return `{ ${type.getProperties().map(property => {
                const readonly = ts.getCheckFlags(property) & ts.CheckFlags.Readonly
                  || property.declarations?.some(node => ts.getCombinedModifierFlags(node) & ts.ModifierFlags.Readonly)
                const optional = property.flags & ts.SymbolFlags.Optional
                const value = checker.getTypeOfSymbolAtLocation(property, declaration)
                return `${readonly ? 'readonly ' : ''}${JSON.stringify(property.name)}${optional ? '?' : ''}: ${render(value)}`
              }).join('; ')} }`
            }
            const node = checker.typeToTypeNode(type, declaration, ts.NodeBuilderFlags.NoTruncation
              | ts.NodeBuilderFlags.UseAliasDefinedOutsideCurrentScope)
            if (!node) throw new Error('Original contract type could not be named.')
            const text = print(node)
            if (text.includes('elided')) throw new Error('Truncated contract type refused.')
            return text
          } finally { active.delete(type) }
        }
        let annotation
        if (declaration.name.text === 'WsRpcGroup') {
          if (!ts.isCallExpression(expression) || !ts.isPropertyAccessExpression(expression.expression)
            || expression.expression.name.text !== 'middleware' || expression.arguments.length !== 1) {
            throw new Error('Original RPC middleware construction changed.')
          }
          const make = expression.expression.expression
          if (!ts.isCallExpression(make) || make.expression.getText(source) !== 'RpcGroup.make'
            || !make.arguments.every(ts.isIdentifier)) throw new Error('Original RPC group construction changed.')
          annotation = `RpcGroup.RpcGroup<Rpc.AddMiddleware<${make.arguments.map(node =>
            `typeof ${node.text}`).join(' | ')}, typeof ${expression.arguments[0].getText(source)}>>`
        } else annotation = render(root)
        const checkName = `__NessieContractExact_${declaration.name.text}`
        if (source.text.includes(checkName)) throw new Error('Contract verification name conflict.')
        const original = ts.isClassDeclaration(declaration) ? `${checkName}_base` : declaration.name.text
        if (ts.isClassDeclaration(declaration)) assertions.push(`const ${original} = ${expression.getText(source)};`)
        assertions.push(`const ${checkName}: (<T>() => T extends (${annotation}) ? 1 : 2) extends `
          + `(<T>() => T extends typeof ${original} ? 1 : 2) ? true : false = true;`)
        edits.push(ts.isClassDeclaration(declaration)
          ? { start: expression.getStart(source), end: expression.end,
            text: `(${expression.getText(source)} as ${annotation})` }
          : { start: declaration.name.end, end: declaration.name.end, text: `: ${annotation}` })
        records.push({ path, name: declaration.name.text, sourceSha256: hash(source.text),
          annotationSha256: hash(annotation) })
      }
    }
    if (edits.length !== names.length) throw new Error('Original contract naming selection changed.')
    let text = source.text
    for (const edit of edits.sort((a, b) => b.start - a.start)) {
      text = text.slice(0, edit.start) + edit.text + text.slice(edit.end)
    }
    sources.set(source.fileName, text)
    checks.set(source.fileName, `${source.text}\n${assertions.join('\n')}\n`)
  }
  return { sources, checks, records }
}
