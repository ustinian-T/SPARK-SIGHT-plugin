// 生成 SPDX 2.3 依赖清单（SBOM），覆盖本仓库两个 npm 工作区。
// 共享本地 Agent 没有运行时 npm 依赖，因此不在清单中。
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'

const root = process.cwd()
const lockFiles = ['apps/web/package-lock.json', 'apps/vscode/package-lock.json']
const packages = new Map()

const safeId = (value) => `SPDXRef-${value.replace(/[^A-Za-z0-9.-]+/g, '-')}`

for (const relative of lockFiles) {
  const lock = JSON.parse(fs.readFileSync(path.join(root, relative), 'utf8'))
  for (const [location, item] of Object.entries(lock.packages ?? {})) {
    if (!location || !item?.version) continue
    const name = item.name || location.split('node_modules/').at(-1)
    if (!name) continue
    const key = `npm:${name}@${item.version}`
    packages.set(key, {
      name,
      SPDXID: safeId(key),
      versionInfo: item.version,
      downloadLocation: 'NOASSERTION',
      filesAnalyzed: false,
      licenseConcluded: 'NOASSERTION',
      licenseDeclared: item.license || 'NOASSERTION',
      copyrightText: 'NOASSERTION',
      externalRefs: [{ referenceCategory: 'PACKAGE-MANAGER', referenceType: 'purl', referenceLocator: `pkg:npm/${encodeURIComponent(name)}@${item.version}` }]
    })
  }
}

let revision = 'unknown'
try { revision = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim() } catch {}

// 根包是聚合包，其各部分许可不同，见 docs/licensing.md。
const rootPackage = {
  name: 'spark-sight-plugin',
  SPDXID: 'SPDXRef-Package-spark-sight-plugin',
  versionInfo: '0.1.0',
  downloadLocation: 'NOASSERTION',
  filesAnalyzed: false,
  licenseConcluded: 'NOASSERTION',
  licenseDeclared: 'MIT AND LicenseRef-Deep-Imaging-NC-Attribution-1.0 AND OFL-1.1',
  copyrightText: 'Copyright 2026 Deep Imaging contributors'
}

const dependencyPackages = [...packages.values()].sort((a, b) => a.SPDXID.localeCompare(b.SPDXID))
const document = {
  spdxVersion: 'SPDX-2.3',
  dataLicense: 'CC0-1.0',
  SPDXID: 'SPDXRef-DOCUMENT',
  name: 'spark-sight-plugin-sbom',
  documentNamespace: `https://github.com/ustinian-T/SPARK-SIGHT-plugin/spdx/${revision}`,
  creationInfo: { created: new Date().toISOString(), creators: ['Tool: scripts/generate-sbom.mjs'] },
  packages: [rootPackage, ...dependencyPackages],
  relationships: [
    { spdxElementId: 'SPDXRef-DOCUMENT', relationshipType: 'DESCRIBES', relatedSpdxElement: rootPackage.SPDXID },
    ...dependencyPackages.map((item) => ({ spdxElementId: rootPackage.SPDXID, relationshipType: 'DEPENDS_ON', relatedSpdxElement: item.SPDXID }))
  ],
  hasExtractedLicensingInfos: [{
    licenseId: 'LicenseRef-Deep-Imaging-NC-Attribution-1.0',
    name: 'Deep Imaging 非商业使用与署名许可 1.0',
    extractedText: '见仓库根目录 LICENSE。这是含非商业限制的源码可用许可，不是 OSI 批准的开源许可。',
    seeAlsos: ['https://github.com/ustinian-T/SPARK-SIGHT-plugin/blob/main/LICENSE']
  }]
}
fs.writeFileSync(path.join(root, 'sbom.spdx.json'), `${JSON.stringify(document, null, 2)}\n`)
process.stdout.write(`[sbom] wrote ${dependencyPackages.length + 1} packages to sbom.spdx.json\n`)
