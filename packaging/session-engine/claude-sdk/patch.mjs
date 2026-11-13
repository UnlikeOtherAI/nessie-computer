import { createHash } from 'node:crypto'
import ts from 'typescript'

export const sdkSha256 = 'dc85a850b6806de3c5dd19b9c1412ac7410546741e5f79a4e7a8e984e4135442'
const refuse = () => { throw new Error('SESSION_CLAUDE_SDK_SOURCE_MISMATCH') }

/** Edits bind to the entire pinned artifact and exact AST shapes. Ordinary
 * query/spawn stays upstream; only the private entry supplies a native owner. */
export function patchClaudeSdk(bytes) {
  if (createHash('sha256').update(bytes).digest('hex') !== sdkSha256) refuse()
  const text = bytes.toString('utf8')
  const source = ts.createSourceFile('sdk.mjs', text, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS)
  const edits = []
  const replace = (node, value) => edits.push({ start: node.getStart(source), end: node.end, value })
  const insert = (position, value) => edits.push({ start: position, end: position, value })
  const named = (kind, name) => {
    const found = source.statements.filter(node => kind(node) && node.name?.text === name)
    if (found.length !== 1) refuse()
    return found[0]
  }
  const query = named(ts.isClassDeclaration, 'zy')
  const builder = named(ts.isFunctionDeclaration, 'qv')
  const method = name => {
    const members = query.members.filter(node => node.name?.getText(source) === name)
    if (members.length !== 1 || !members[0].body) refuse()
    return members[0]
  }
  const collect = (node, predicate) => {
    const found = []
    const visit = child => { if (predicate(child)) found.push(child); ts.forEachChild(child, visit) }
    visit(node)
    return found
  }
  const one = (node, predicate) => {
    const found = collect(node, predicate)
    if (found.length !== 1) refuse()
    return found[0]
  }
  const spawn = one(builder, node => ts.isNewExpression(node) && node.expression.getText(source) === 'Iv')
  if (spawn.arguments.length !== 1 || !ts.isObjectLiteralExpression(spawn.arguments[0])) refuse()
  // Iv.initialize constructs Be immediately before either actual spawn branch.
  // Reuse that exact method with a private descriptor hold, never a fake process.
  replace(spawn, `__sessionTransport(t,${spawn.arguments[0].getText(source)})`)
  const process = named(ts.isClassDeclaration, 'Iv')
  const initialize = process.members.find(node => node.name?.getText(source) === 'initialize')
  const spawnBranch = one(initialize, node => ts.isIfStatement(node)
    && node.expression.getText(source) === 'this.options.spawnClaudeCodeProcess')
  insert(spawnBranch.getStart(source), 'if(__sessionHolds.has(this.options))return __sessionHolds.get(this.options)(Be);')

  const request = method('request')
  const encodedRequest = one(request, node => ts.isVariableDeclaration(node)
    && node.name.getText(source) === 'f' && node.initializer?.getText(source) === 'ae(o)+`\n`')
  replace(encodedRequest.initializer, `__sessionCapture(this,${encodedRequest.initializer.getText(source)})`)
  const delayed = method('writeAfterInitialize')
  insert(delayed.body.getStart(source) + 1, 'e=__sessionCapture(this,e);')
  const input = method('streamInput')
  const user = one(input, node => ts.isCallExpression(node)
    && node.expression.getText(source) === 'this.transport.write')
  const originalUser = user.arguments[0].getText(source)
  if (originalUser !== 'ae(this.verbatimPrompts?{...n,client_composed:!0}:n)+`\n`') refuse()
  replace(user.arguments[0], '__sessionUser(this,n)')
  // The remaining writes have no intermediate queue. Capture at the actual
  // original encoder/write boundary, including cancellation and response bytes.
  for (const name of ['request', 'handleControlRequest']) {
    const calls = collect(method(name), node => ts.isCallExpression(node)
      && node.expression.getText(source) === 'this.transport.write')
    for (const call of calls) {
      if (call.arguments[0].getText(source) !== 'f') {
        replace(call.arguments[0], `__sessionCapture(this,${call.arguments[0].getText(source)})`)
      }
    }
  }
  if (collect(query, node => ts.isCallExpression(node)
    && node.expression.getText(source) === 'this.transport.write').length !== 6) refuse()
  const helper = `
const __sessionHolds=new WeakMap(),__sessionOwners=new WeakMap();
function __sessionTransport(config,options){
 if(!config.sessionNative)return new Iv(options);
 let descriptor;
 __sessionHolds.set(options,value=>{descriptor=value});
 try{Iv.prototype.initialize.call({options,forwardedAbort:options.abortController})}
 finally{__sessionHolds.delete(options)}
 if(!descriptor)throw Error('SESSION_CLAUDE_DESCRIPTOR_ABSENT');
 const transport=config.sessionNative.open(descriptor,Iv.prototype.readMessages);
 __sessionOwners.set(transport,config.sessionNative);
 return transport;
}
function __sessionCapture(query,encoded){return __sessionOwners.get(query.transport)?.capture(encoded)??encoded}
function __sessionEncodeUser(query,message){return ${originalUser.replaceAll('this.', 'query.').replaceAll('...n,', '...message,').replace(':n)', ':message)')}}
function __sessionUser(query,message){
 const owner=__sessionOwners.get(query.transport);
 return owner?owner.prompt(message):__sessionEncodeUser(query,message);
}
export function createSessionNativeQuery(options,owner){
 const {queryInstance}=qv(options,{isSingleUserTurn:false,sessionNative:owner});
 return {query:queryInstance,encodePrompt:message=>__sessionEncodeUser(queryInstance,message)};
}
`
  const ordered = edits.sort((a, b) => b.start - a.start)
  let boundary = text.length, patched = text
  for (const edit of ordered) {
    if (edit.end > boundary) refuse()
    patched = patched.slice(0, edit.start) + edit.value + patched.slice(edit.end)
    boundary = edit.start
  }
  return { source: patched + helper, edits: ordered.map(({ start, end }) => ({ start, end })) }
}
