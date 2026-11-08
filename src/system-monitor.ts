import { readFile, readdir, statfs } from 'node:fs/promises'
import { cpus, freemem, homedir, hostname, loadavg, networkInterfaces, platform, totalmem, uptime } from 'node:os'
import { EXECUTOR_MONITOR_HISTORY_MS, type ExecutorMonitorSnapshot } from '@nessie/executor-protocol'

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

type GpuReading = { utilization: number | null; used: number | null; total: number | null }
export const nvidiaGpuReading = (output: string): GpuReading => {
  const values = output.trim().split('\n').map(line => line.split(',').map(part => part.trim())).map(parts => ({
    utilization: parts[0] ? percent(Number(parts[0])) : null,
    used: parts[1] ? Number(parts[1]) : NaN, total: parts[2] ? Number(parts[2]) : NaN,
  }))
  const utilizations = values.flatMap(value => value.utilization === null ? [] : [value.utilization])
  const memory = values.filter(value => Number.isFinite(value.used) && Number.isFinite(value.total)
    && value.total > 0 && value.used >= 0 && value.used <= value.total)
  return { utilization: utilizations.length ? Math.max(...utilizations) : null,
    used: memory.length ? memory.reduce((sum, value) => sum + value.used * 1024 ** 2, 0) : null,
    total: memory.length ? memory.reduce((sum, value) => sum + value.total * 1024 ** 2, 0) : null }
}
type IdleReading = { at: number; ms: number }
export const rc6Utilization = (previous: IdleReading | undefined, next: IdleReading): number | null =>
  previous && next.at > previous.at && next.ms >= previous.ms
    ? Math.max(0, Math.min(100, 100 * (1 - (next.ms - previous.ms) / (next.at - previous.at)))) : null

const gpu = async (idle: Map<string, IdleReading>): Promise<GpuReading> => {
  const nvidia = await run('nvidia-smi', ['--query-gpu=utilization.gpu,memory.used,memory.total', '--format=csv,noheader,nounits'])
  const reading = nvidia !== null ? nvidiaGpuReading(nvidia) : { utilization: null, used: null, total: null }
  if (reading.utilization !== null) return reading
  // VRAM availability is independent of utilization. Preserve it through OS counter fallback.
  const simple = (utilization: number | null): GpuReading => ({ ...reading, utilization })
  if (platform() === 'win32') {
    const text = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
      '$c=Get-Counter "\GPU Engine(*)\Utilization Percentage" -ErrorAction Stop; '
      + '($c.CounterSamples|Measure-Object CookedValue -Maximum).Maximum'])
    return simple(text?.trim() ? percent(Number(text.trim())) : null)
  }
  if (platform() === 'darwin') {
    const text = await run('/usr/sbin/ioreg', ['-r', '-c', 'IOAccelerator', '-d', '1'])
    const values = [...(text ?? '').matchAll(/"Device Utilization %"\s*=\s*(\d+)/gu)]
      .map((match) => Number(match[1]))
    return simple(values.length ? percent(Math.max(...values)) : null)
  }
  const cards = await readdir('/sys/class/drm').catch(() => [])
  const values = await Promise.all(cards.filter((name) => /^card\d+$/u.test(name)).map(async (name) => {
    const value = await readFile(`/sys/class/drm/${name}/device/gpu_busy_percent`, 'utf8').catch(() => '')
    const busy = value.trim() ? percent(Number(value.trim())) : null
    if (busy !== null) return busy
    for (const suffix of ['gt/gt0/rc6_residency_ms', 'power/rc6_residency_ms']) {
      const path = `/sys/class/drm/${name}/${suffix}`
      const text = await readFile(path, 'utf8').catch(() => '')
      if (!text.trim() || !Number.isFinite(Number(text)) || Number(text) < 0) continue
      const next = { at: Date.now(), ms: Number(text) }
      const measured = rc6Utilization(idle.get(path), next)
      idle.set(path, next)
      return measured
    }
    return null
  }))
  const measured = values.filter((value): value is number => value !== null)
  return simple(measured.length ? Math.max(...measured) : null)
}

/** Retain measured points by time as well as count, including gaps after sleep. */
export const appendMonitorHistory = (
  history: ExecutorMonitorSnapshot['history'], point: ExecutorMonitorSnapshot['history'][number],
): ExecutorMonitorSnapshot['history'] => [...history.filter((sample) =>
  Date.parse(sample.at) > Date.parse(point.at) - EXECUTOR_MONITOR_HISTORY_MS), point].slice(-24)

/** One real host sampler; missing counters stay null rather than becoming invented zeroes. */
export const createSystemMonitor = () => {
  let previous = cpuTimes()
  let history: ExecutorMonitorSnapshot['history'] = []
  const idle = new Map<string, IdleReading>()
  return async (): Promise<Omit<ExecutorMonitorSnapshot, 'subscriptions'>> => {
    const [memory, storage, top, graphics] = await Promise.all([availableMemory(), disk(), processes(), gpu(idle)])
    const next = cpuTimes()
    const elapsed = next.total - previous.total
    const cpu = elapsed > 0 ? percent(100 * (1 - (next.idle - previous.idle) / elapsed)) : null
    previous = next
    const now = Date.now()
    const capturedAt = new Date(now).toISOString()
    history = appendMonitorHistory(history, { at: capturedAt, cpu, gpu: graphics.utilization })
    const total = totalmem()
    return {
      capturedAt, os: platform() === 'win32' ? 'windows' : platform() === 'darwin' ? 'macos' : 'linux',
      processor: `${cpus()[0]?.model ?? ''} · ${cpus().length}`, cpu, gpu: graphics.utilization, history,
      hostname: hostname().slice(0, 200), cores: Math.max(1, cpus().length),
      address: Object.values(networkInterfaces()).flat().find(value => value && !value.internal && value.family === 'IPv4')?.address ?? null,
      load: platform() === 'win32' ? null : loadavg()[0] ?? null,
      gpuMemoryUsedBytes: graphics.used, gpuMemoryTotalBytes: graphics.total,
      memoryTotalBytes: total, memoryUsedBytes: Math.max(0, total - Math.min(total, memory)),
      diskUsedBytes: storage?.used ?? null, diskTotalBytes: storage?.total ?? null,
      uptimeSeconds: uptime(), processes: top,
    }
  }
}
