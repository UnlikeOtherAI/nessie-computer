import { createHash } from 'node:crypto'
import ts from 'typescript'

/** Inventory declarations only. No server module is imported or executed. */
export const extractT3RawHttp = snapshot => {
  const routes = []
  for (const path of snapshot.files.filter(path => path.startsWith('apps/server/src/')
    && path.endsWith('.ts') && !path.endsWith('.test.ts'))) {
    const bytes = snapshot.read(path)
    const text = bytes.toString('utf8')
    if (!text.includes('HttpRouter.add') && !text.includes('router.add')) continue
    const tree = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true)
    const walk = node => {
      if (ts.isCallExpression(node) && ['HttpRouter.add', 'router.add'].includes(node.expression.getText(tree))) {
        const line = tree.getLineAndCharacterOfPosition(node.getStart(tree)).line + 1
        routes.push({ id: `${path}:${line}`, source: path, line,
          methodExpression: node.arguments[0]?.getText(tree), pathExpression: node.arguments[1]?.getText(tree),
          sourceSha256: createHash('sha256').update(bytes).digest('hex') })
      }
      ts.forEachChild(node, walk)
    }
    walk(tree)
  }
  return routes.sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
}
