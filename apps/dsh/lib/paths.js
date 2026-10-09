import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

export function resolvePersistentDataDir(config = {}, { agentDir, env = process.env, home = os.homedir(), platform = process.platform } = {}) {
  if (config.dataDir) return String(config.dataDir)
  if (env.LOCAL_AGENT_DATA_DIR) return env.LOCAL_AGENT_DATA_DIR
  const root = platform === 'win32' ? env.LOCALAPPDATA || path.join(home, 'AppData', 'Local') : platform === 'darwin' ? path.join(home, 'Library', 'Application Support') : env.XDG_DATA_HOME || path.join(home, '.local', 'share')
  const destination = path.join(root, 'SPARK-SIGHT', 'dsh', 'agent-data')
  const legacy = agentDir && path.join(agentDir, '.data')
  // Leave the source intact. Never overwrite a newer persistent profile/project.
  if (legacy && fs.existsSync(legacy) && !fs.existsSync(destination)) {
    fs.mkdirSync(path.dirname(destination), { recursive: true })
    fs.cpSync(legacy, destination, { recursive: true, force: false, errorOnExist: true, filter: (entry) => {
      if (fs.lstatSync(entry).isSymbolicLink()) throw new Error('Legacy DSH data contains a symbolic link; set dataDir explicitly to preserve it')
      return true
    } })
  }
  return destination
}
