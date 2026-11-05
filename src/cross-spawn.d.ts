// cross-spawn ships no types of its own. It takes node's own spawn arguments
// and returns node's own ChildProcess, which is all the daemon relies on: it is
// what the MCP SDK starts every local server with, and Kelpie detection starts
// `describe` with it so both resolve a program the same way.
declare module 'cross-spawn' {
  import type { spawn } from 'node:child_process'

  const crossSpawn: typeof spawn
  export default crossSpawn
}
