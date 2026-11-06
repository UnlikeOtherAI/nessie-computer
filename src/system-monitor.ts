import { readFile, readdir, statfs } from 'node:fs/promises'
import { cpus, freemem, homedir, platform, totalmem, uptime } from 'node:os'
import type { ExecutorMonitorSnapshot } from '@nessie/executor-protocol'

import { runCommand } from './coding-session/agent-env.js'

type Processes = ExecutorMonitorSnapshot['processes']
type CpuTimes = { idle: number; total: number }
const cpuTimes = (): CpuTimes => cpus().reduce((sum, cpu) => ({
  idle: sum.idle + cpu.times.idle,
  total: sum.total + Object.values(cpu.times).reduce((value, time) => value + time, 0),
}), { idle: 0, total: 0 })

const percent = (value: number): number | null => Number.isFinite(value) && value >= 0 && value <= 100 ? value : null
const run = async (file: string, args: string[]): Promise<string | null> => {
  const result = await runCommand(file, args, { timeoutMs: 4_000, maxBytes: 256 * 1024 })
  return result.code === 0 ? result.stdout : null
}

const availableMemory = async (): Promise<number> => {
  if (platform() === 'linux') {
    const info = await readFile('/proc/meminfo', 'utf8').catch(() => '')
    const available = /^MemAvailable:\s+(\d+)\s+kB$/mu.exec(info)?.[1]
    if (available) return Number(available) * 1024
  }
  if (platform() === 'darwin') {
    const info = await run('/usr/bin/vm_stat', [])
    const pageSize = Number(/page size of (\d+) bytes/u.exec(info ?? '')?.[1])
    const values = ['free', 'inactive', 'speculative'].map((kind) =>
      /^\d+$/u.test(new RegExp(`^Pages ${kind}:\\s+(\\d+)\\.`, 'mu').exec(info ?? '')?.[1] ?? '')
        ? Number(new RegExp(`^Pages ${kind}:\\s+(\\d+)\\.`, 'mu').exec(info ?? '')![1]) : NaN)
    if (Number.isFinite(pageSize) && values.every(Number.isFinite)) return values.reduce((a, b) => a + b) * pageSize
  }
  return freemem()
}

const disk = async (): Promise<{ used: number; total: number } | null> => {
  try {
    const value = await statfs(homedir())
    return { used: (value.blocks - value.bavail) * value.bsize, total: value.blocks * value.bsize }
  } catch {
    if (platform() !== 'win32') return null
    const text = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
      '$d=Get-CimInstance Win32_LogicalDisk -Filter "DeviceID=\'$env:SystemDrive\'"; '
      + 'if($d){@{used=([double]$d.Size-[double]$d.FreeSpace);total=[double]$d.Size}|ConvertTo-Json -Compress}'])
    try {
      const value = JSON.parse(text ?? '') as { used?: unknown; total?: unknown }
      return typeof value.used === 'number' && typeof value.total === 'number' && value.total > 0
        ? { used: value.used, total: value.total } : null
    } catch { return null }
  }
}

const processes = async (): Promise<Processes> => {
  if (platform() === 'win32') {
    const script = 'Get-CimInstance Win32_PerfFormattedData_PerfProc_Process | '
      + 'Where-Object {$_.IDProcess -gt 0 -and $_.Name -ne "_Total"} | '
      + 'Sort-Object PercentProcessorTime -Descending | Select-Object -First 10 '
      + '@{n="pid";e={$_.IDProcess}},@{n="name";e={$_.Name}},'
      + `@{n="cpu";e={[double]$_.PercentProcessorTime/${Math.max(1, cpus().length)}}},`
      + '@{n="memoryBytes";e={[double]$_.WorkingSetPrivate}} | ConvertTo-Json -Compress'
    const text = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script])
    try {
      const value: unknown = JSON.parse(text ?? '')
      return (Array.isArray(value) ? value : [value]).flatMap((item: unknown) => {
        if (!item || typeof item !== 'object') return []
        const row = item as Record<string, unknown>
        return typeof row.pid === 'number' && typeof row.name === 'string'
          ? [{ pid: row.pid, name: row.name.slice(0, 200), cpu: typeof row.cpu === 'number' ? row.cpu : null,
            memoryBytes: typeof row.memoryBytes === 'number' ? row.memoryBytes : null }] : []
      })
    } catch { return [] }
  }
  const text = await run('/bin/ps', ['-A', '-o', 'pid=,pcpu=,rss=,comm='])
  return (text ?? '').split('\n').flatMap((line) => {
    const match = /^\s*(\d+)\s+([\d.]+)\s+(\d+)\s+(.+)$/u.exec(line)
    return match ? [{ pid: Number(match[1]), cpu: Number(match[2]), memoryBytes: Number(match[3]) * 1024,
      name: match[4]!.split('/').at(-1)!.slice(0, 200) }] : []
  }).sort((a, b) => b.cpu - a.cpu).slice(0, 10)
}

const gpu = async (): Promise<number | null> => {
  const nvidia = await run('nvidia-smi', ['--query-gpu=utilization.gpu', '--format=csv,noheader,nounits'])
  if (nvidia !== null) {
    const values = nvidia.trim().split('\n').filter((line) => line.trim().length > 0)
      .map((line) => percent(Number(line.trim())))
      .filter((value): value is number => value !== null)
    if (values.length) return Math.max(...values)
  }
  if (platform() === 'win32') {
    const text = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
      '$c=Get-Counter "\GPU Engine(*)\Utilization Percentage" -ErrorAction Stop; '
      + '($c.CounterSamples|Measure-Object CookedValue -Maximum).Maximum'])
    return text?.trim() ? percent(Number(text.trim())) : null
  }
  if (platform() === 'darwin') {
    const text = await run('/usr/sbin/ioreg', ['-r', '-c', 'IOAccelerator', '-d', '1'])
    const values = [...(text ?? '').matchAll(/"Device Utilization %"\s*=\s*(\d+)/gu)]
      .map((match) => Number(match[1]))
    return values.length ? percent(Math.max(...values)) : null
  }
  const cards = await readdir('/sys/class/drm').catch(() => [])
  const values = await Promise.all(cards.filter((name) => /^card\d+$/u.test(name)).map(async (name) => {
    const value = await readFile(`/sys/class/drm/${name}/device/gpu_busy_percent`, 'utf8').catch(() => '')
    return value.trim() ? percent(Number(value.trim())) : null
  }))
  const measured = values.filter((value): value is number => value !== null)
  return measured.length ? Math.max(...measured) : null
}

/** One real host sampler; missing counters stay null rather than becoming invented zeroes. */
export const createSystemMonitor = () => {
  let previous = cpuTimes()
  let history: ExecutorMonitorSnapshot['history'] = []
  return async (): Promise<Omit<ExecutorMonitorSnapshot, 'subscriptions'>> => {
    const [memory, storage, top, graphics] = await Promise.all([availableMemory(), disk(), processes(), gpu()])
    const next = cpuTimes()
    const elapsed = next.total - previous.total
    const cpu = elapsed > 0 ? percent(100 * (1 - (next.idle - previous.idle) / elapsed)) : null
    previous = next
    const now = Date.now()
    const capturedAt = new Date(now).toISOString()
    history = [...history.filter((sample) => Date.parse(sample.at) > now - 60_000),
      { at: capturedAt, cpu, gpu: graphics }].slice(-24)
    const total = totalmem()
    return {
      capturedAt, os: platform() === 'win32' ? 'windows' : platform() === 'darwin' ? 'macos' : 'linux',
      processor: `${cpus()[0]?.model ?? ''} · ${cpus().length}`, cpu, gpu: graphics, history,
      memoryTotalBytes: total, memoryUsedBytes: Math.max(0, total - Math.min(total, memory)),
      diskUsedBytes: storage?.used ?? null, diskTotalBytes: storage?.total ?? null,
      uptimeSeconds: uptime(), processes: top,
    }
  }
}
