// Real pipe/exit fixture. It cannot be selected by the packaged production CLI.
const mode = process.argv[2]
if (mode === 'oversized') process.stdout.write('x'.repeat(4096))
else if (mode === 'invalid') process.stdout.write('{invalid}\n')
else {
  const frame = JSON.stringify({ version: 1, nonce: mode }) + '\n'
  process.stdout.write(frame.slice(0, 3))
  setImmediate(() => {
    process.stdout.write(frame.slice(3))
    if (mode === 'early-close') process.exit(0)
  })
}
let input = ''
process.stdin.on('data', bytes => { input += bytes })
process.stdin.on('end', () => {
  if (input !== 'release\n') process.exit(2)
  process.exit(mode === 'failed-release' ? 1 : 0)
})
