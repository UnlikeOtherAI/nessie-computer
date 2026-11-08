import { createHash } from 'node:crypto'
import ts from 'typescript'

/** Structural inventory from the original schema; no application evaluation. */
export const extractT3CommandInventory = snapshot => {
  const source = 'packages/contracts/src/orchestrationV2.ts'
  const bytes = snapshot.read(source)
  const tree = ts.createSourceFile(source, bytes.toString('utf8'), ts.ScriptTarget.Latest, true)
  const definitions = tree.statements.filter(ts.isVariableStatement).flatMap(statement =>
    [...statement.declarationList.declarations]).filter(declaration =>
    ts.isIdentifier(declaration.name) && declaration.name.text === 'OrchestrationV2InternalCommand')
  const initializer = definitions.length === 1 ? definitions[0].initializer : undefined
  const call = (node, name) => node && ts.isCallExpression(node) && node.expression.getText(tree) === name
  const refuse = () => { throw new Error('T3_COMMAND_INVENTORY_SOURCE_CHANGED') }
  if (!call(initializer, 'Schema.Union') || initializer.arguments.length !== 1
    || !ts.isArrayLiteralExpression(initializer.arguments[0])) refuse()
  const internalCommands = initializer.arguments[0].elements.map(member => {
    if (!call(member, 'Schema.Struct') || member.arguments.length !== 1
      || !ts.isObjectLiteralExpression(member.arguments[0])) return refuse()
    const fields = member.arguments[0].properties.filter(property => ts.isPropertyAssignment(property)
      && (ts.isIdentifier(property.name) || ts.isStringLiteral(property.name)) && property.name.text === 'type')
    const type = fields.length === 1 ? fields[0].initializer : undefined
    if (!call(type, 'Schema.Literal') || type.arguments.length !== 1
      || !ts.isStringLiteral(type.arguments[0])) return refuse()
    return type.arguments[0].text
  })
  if (!internalCommands.length || new Set(internalCommands).size !== internalCommands.length) refuse()
  return { format: 1, source, sourceSha256: createHash('sha256').update(bytes).digest('hex'), internalCommands }
}
