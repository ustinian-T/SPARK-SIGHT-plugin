// Each custom script gets its own namespaces and a filesystem containing only
// interpreter libraries and this execution's data. No Agent data or secrets.
import fs from 'node:fs'
import { spawnSync } from 'node:child_process'
import { probeWslSandbox } from './wslSandbox.js'

let cached
export function isolationAvailable() {
  if (process.platform === 'win32') return probeWslSandbox()?.available === true
  if (process.env.DEEP_IMAGING_SANDBOX !== 'bubblewrap' || process.platform !== 'linux') return false
  if (cached !== undefined) return cached
  const probe = spawnSync('bwrap', ['--unshare-all', '--die-with-parent', '--ro-bind', '/usr', '/usr', '--symlink', 'usr/bin', '/bin', '--ro-bind', '/lib', '/lib', ...(fs.existsSync('/lib64') ? ['--ro-bind', '/lib64', '/lib64'] : []), '--tmpfs', '/tmp', '--dev', '/dev', '--dir', '/proc', '--', '/usr/bin/true'], { timeout: 5000, stdio: 'ignore' })
  cached = !probe.error && probe.status === 0 && spawnSync('prlimit', ['--version'], { timeout: 2000, stdio: 'ignore' }).status === 0
  return cached
}

export function isolatedCommand({ engine, script, workdir }) {
  if (!isolationAvailable()) throw Object.assign(new Error('独立执行沙箱未就绪，请检查 bubblewrap 与用户命名空间'), { code: 'STRONG_SANDBOX_REQUIRED' })
  if (!['python', 'r'].includes(engine)) throw new Error('隔离执行仅支持 Python / R')
  const libraries = ['/usr', '/lib', '/lib64', '/etc/fonts', '/etc/R', '/etc/alternatives', '/etc/ld.so.cache', '/etc/matplotlibrc'].filter((dir) => fs.existsSync(dir)).flatMap((dir) => ['--ro-bind', dir, dir])
  return {
    cmd: 'prlimit',
    args: ['--as=1073741824', '--cpu=60', '--nproc=256', '--fsize=20971520', '--', 'bwrap',
      '--unshare-all', '--die-with-parent', '--new-session', '--cap-drop', 'ALL',
      ...libraries, '--symlink', 'usr/bin', '/bin', '--dir', '/proc', '--dev', '/dev',
      '--tmpfs', '/tmp', '--bind', workdir, '/work', '--chdir', '/work', '--clearenv',
      ...(fs.existsSync(`${workdir}/.deep-imaging-fonts`) ? ['--ro-bind', `${workdir}/.deep-imaging-fonts`, '/work/.deep-imaging-fonts', '--setenv', 'FONTCONFIG_FILE', '/work/.deep-imaging-fonts/fonts.conf'] : []),
      '--setenv', 'PATH', '/usr/local/bin:/usr/bin:/bin', '--setenv', 'HOME', '/tmp',
      '--setenv', 'LANG', 'C.UTF-8', '--setenv', 'MPLBACKEND', 'Agg',
      '--setenv', 'MPLCONFIGDIR', '/tmp/matplotlib', '--setenv', 'PYTHONUTF8', '1',
      '--setenv', 'OPENBLAS_NUM_THREADS', '1', '--setenv', 'OMP_NUM_THREADS', '1',
      '--', '/usr/bin/env', engine === 'python' ? 'python3' : 'Rscript', script]
  }
}
