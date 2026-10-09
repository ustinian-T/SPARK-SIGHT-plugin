// 科研配色推荐 V2：用户提供的五组预设优先保留，同时按图表作用、学科与历史偏好选择。
// 外部色板来源：ColorBrewer、Seaborn colorblind、ggsci（NPG/NEJM/Lancet/JAMA）、
//               Nature 低饱和（科研规则）、Okabe-Ito / Paul Tol（开源色盲安全）、viridis/magma 系。
// V3（本仓库改进）：接入 colorLearning 用户画像先验，动态调整推荐；新增科研规则渐变。
// 配色只影响视觉方案，不得覆盖数据契合度、可读性或证据约束。
//
// V2 升级要点（阶段 C）：
//  - CIEDE2000 色差（ISO/CIE 11664-6:2019，即 CIE DE2000 standard）替代 Lab 欧氏距离作为可辨性度量；
//  - 色觉缺陷模拟（Vienot 1999 / Brettel-Vienot-Mollon 矩阵），红/绿/蓝三种色盲下逐对评估；
//  - WCAG 相对亮度差驱动的灰度冗余编码建议；
//  - 系列数超过色板容量时不再循环复用颜色，改为 Lab 空间插值补色 + 线型/点型冗余编码。
import { profilePaletteScore } from './colorLearning.js'

export const PALETTE_LIBRARY = Object.freeze({
  user_ocean: {
    id: 'user_ocean', name: '用户预设一·青蓝递进', source: 'user',
    roles: ['sequential', 'time', 'environment'],
    colors: ['#DDF2F0', '#D6F6F1', '#A6EBDD', '#88C9D0', '#929ED2', '#5E8CBE', '#3E5682', '#0F1633']
  },
  user_garden: {
    id: 'user_garden', name: '用户预设二·柔和分类', source: 'user',
    roles: ['categorical', 'comparison', 'general'],
    colors: ['#99BC99', '#FFCC99', '#99BBDE', '#B6B6FF', '#136764', '#FFA579', '#3E85C5', '#A2A2FF']
  },
  user_nature: {
    id: 'user_nature', name: '用户预设三·自然低饱和', source: 'user',
    roles: ['categorical', 'publication', 'engineering'],
    colors: ['#6E8FB2', '#7DA494', '#EAB67A', '#E5A79A', '#C16E71', '#ABC8E5', '#D8A0C1', '#9F8DB8', '#D0D08A']
  },
  user_macaron: {
    id: 'user_macaron', name: '用户预设四·冷暖马卡龙', source: 'user',
    roles: ['categorical', 'presentation', 'social'],
    colors: ['#4C65A4', '#8B8FCA', '#B7AED9', '#E8C1CC', '#FFD7A8', '#F3A683', '#B9786F']
  },
  user_pairs: {
    id: 'user_pairs', name: '用户预设五·成对对照', source: 'user',
    roles: ['paired', 'comparison', 'control'],
    colors: ['#576FA0', '#A7B9D7', '#E3B87F', '#FADCB4', '#B57979', '#DEA3A2', '#9F9F9F', '#CFCECE']
  },
  seaborn_colorblind: {
    id: 'seaborn_colorblind', name: 'Seaborn·色盲友好', source: 'seaborn',
    roles: ['categorical', 'accessibility', 'general'],
    colors: ['#0173B2', '#DE8F05', '#029E73', '#D55E00', '#CC78BC', '#CA9161', '#949494', '#56B4E9']
  },
  ggsci_npg: {
    id: 'ggsci_npg', name: 'ggsci·NPG 风格', source: 'ggsci',
    roles: ['publication', 'life_science', 'categorical'],
    colors: ['#E64B35', '#4DBBD5', '#00A087', '#3C5488', '#F39B7F', '#8491B4', '#91D1C2', '#DC0000']
  },
  ggsci_nejm: {
    id: 'ggsci_nejm', name: 'ggsci·NEJM 风格', source: 'ggsci',
    roles: ['publication', 'medicine', 'categorical'],
    colors: ['#BC3C29', '#0072B5', '#E18727', '#20854E', '#7876B1', '#6F99AD', '#FFDC91', '#EE4C97']
  },
  ggsci_lancet: {
    id: 'ggsci_lancet', name: 'ggsci·Lancet 风格', source: 'ggsci',
    roles: ['publication', 'medicine', 'contrast'],
    colors: ['#00468B', '#ED0000', '#42B540', '#0099B4', '#925E9F', '#FDAF91', '#AD002A', '#ADB6B6']
  },
  ggsci_jama: {
    id: 'ggsci_jama', name: 'ggsci·JAMA 风格', source: 'ggsci',
    roles: ['publication', 'medicine', 'muted'],
    colors: ['#374E55', '#DF8F44', '#00A1D5', '#B24745', '#79AF97', '#6A6599', '#80796B']
  },
  brewer_diverging: {
    id: 'brewer_diverging', name: 'ColorBrewer·蓝红发散', source: 'colorbrewer',
    roles: ['diverging', 'correlation', 'difference'],
    colors: ['#2166AC', '#67A9CF', '#D1E5F0', '#F7F7F7', '#FDDBC7', '#EF8A62', '#B2182B']
  },
  brewer_sequential: {
    id: 'brewer_sequential', name: 'ColorBrewer·蓝绿顺序', source: 'colorbrewer',
    roles: ['sequential', 'intensity', 'map'],
    colors: ['#F7FCFD', '#CCECE6', '#66C2A4', '#238B45', '#005824']
  },
  // ---- 科研规则精华：Nature 低饱和 9 色（《数模国赛MATLAB制图规则 v0.4》§5.1）----
  nature_lowsat: {
    id: 'nature_lowsat', name: 'Nature 低饱和·科研默认', source: 'publication',
    roles: ['categorical', 'publication', 'general'],
    colors: ['#6E8FB2', '#7DA494', '#EAB67A', '#E5A79A', '#C16E71', '#ABC8E5', '#D8A0C1', '#9F8DB8', '#D0D08A']
  },
  // ---- 开源算法色系：色盲安全（Okabe-Ito 2008 / Paul Tol 亮色与柔和）----
  okabe_ito: {
    id: 'okabe_ito', name: 'Okabe-Ito·色盲安全', source: 'open-source',
    roles: ['categorical', 'accessibility', 'general'],
    colors: ['#0072B2', '#E69F00', '#009E73', '#D55E00', '#CC79A7', '#56B4E9', '#F0E442', '#000000']
  },
  paultol_bright: {
    id: 'paultol_bright', name: 'Paul Tol·亮色', source: 'open-source',
    roles: ['categorical', 'accessibility', 'general'],
    colors: ['#4477AA', '#EE6677', '#228833', '#CCBB44', '#66CCEE', '#AA3377', '#BBBBBB']
  },
  paultol_muted: {
    id: 'paultol_muted', name: 'Paul Tol·柔和', source: 'open-source',
    roles: ['categorical', 'publication', 'general'],
    colors: ['#332288', '#88CCEE', '#44AA99', '#117733', '#999933', '#DDCC77', '#CC6677', '#882255', '#AA4499', '#DDDDDD']
  },
  // ---- 感知均匀顺序渐变（开源算法：viridis / magma 低饱和替代）----
  viridis_like: {
    id: 'viridis_like', name: '感知均匀·Viridis 系', source: 'open-source',
    roles: ['sequential', 'intensity', 'map'],
    colors: ['#440154', '#3B528B', '#21918C', '#5EC962', '#FDE725']
  },
  magma_like: {
    id: 'magma_like', name: '感知均匀·Magma 系', source: 'open-source',
    roles: ['sequential', 'intensity', 'map'],
    colors: ['#000004', '#51127C', '#B63679', '#FB8861', '#FCFDBF']
  },
  // ---- 公开科研文章常用定性色系（ColorBrewer Set2 缓和版）----
  brewer_set2: {
    id: 'brewer_set2', name: 'ColorBrewer·Set2 定性', source: 'colorbrewer',
    roles: ['categorical', 'publication', 'general'],
    colors: ['#66C2A5', '#FC8D62', '#8DA0CB', '#E78AC3', '#A6D854', '#FFD92F', '#E5C494', '#B3B3B3']
  }
})

/**
 * 三种允许的连续渐变（v0.4 §5.2，跨引擎 RGB 输出）：
 *  - blueWhiteRed 蓝白红发散：相关系数、正负偏差、损益方向（白为 0）
 *  - purpleYellow 紫黄强度：贡献度、权重、指标得分
 *  - blueGreen 蓝绿自然量：温度、浓度、距离、时间演化
 * 每个渐变输出 n 步 [r,g,b] 数组（0~1）。
 */
export function buildGradient(name, n = 128) {
  const stops = {
    blueWhiteRed: ['#6E8FB2', '#FFFFFF', '#C16E71'],
    purpleYellow: ['#9F8DB8', '#EAB67A'],
    blueGreen: ['#6E8FB2', '#7DA494']
  }
  const key = stops[name] ? name : null
  if (!key || !Number.isFinite(n) || n < 2) return []
  const from = stops[key].map(parseHex)
  const out = []
  for (let i = 0; i < n; i += 1) {
    const t = i / (n - 1)
    if (from.length === 3) {
      const seg = t < 0.5 ? [0, 1, t * 2] : [1, 2, (t - 0.5) * 2]
      out.push([
        from[seg[0]][0] + (from[seg[1]][0] - from[seg[0]][0]) * seg[2],
        from[seg[0]][1] + (from[seg[1]][1] - from[seg[0]][1]) * seg[2],
        from[seg[0]][2] + (from[seg[1]][2] - from[seg[0]][2]) * seg[2]
      ])
    } else {
      out.push(from[0].map((v, j) => v + (from[1][j] - v) * t))
    }
  }
  return out
}

export const SEQUENTIAL_GRADIENTS = Object.freeze({
  blueWhiteRed: { name: '蓝白红发散', roles: ['diverging', 'correlation', 'difference'] },
  purpleYellow: { name: '紫黄强度', roles: ['sequential', 'intensity', 'weight'] },
  blueGreen: { name: '蓝绿自然量', roles: ['sequential', 'environment', 'map'] }
})

const USER_IDS = ['user_ocean', 'user_garden', 'user_nature', 'user_macaron', 'user_pairs']

// 冗余编码建议库：灰度/色盲下颜色不可分，改用线型与点型差异区分系列。
export const REDUNDANT_LINE_STYLES = Object.freeze(['solid', 'dashed', 'dotted', 'dashdot'])
export const REDUNDANT_MARKERS = Object.freeze(['o', 's', '^', 'D', 'v', '*'])

function parseRequest(text = '') {
  const explicit = /(?:palette|配色预设)\s*[=:：]\s*([a-z0-9_-]+)/i.exec(text)?.[1]
  const role = /相关|正负|差异|偏差|盈亏/i.test(text) ? 'diverging'
    : /热力|强度|浓度|温度|距离|时序|时间/i.test(text) ? 'sequential'
      : /对照|成对|前后|实验组|控制组/i.test(text) ? 'paired' : 'categorical'
  const discipline = /医学|临床|生物|生命|药/i.test(text) ? 'medicine'
    : /环境|生态|地理|农业|气象/i.test(text) ? 'environment'
      : /工程|材料|机械|电子|计算机/i.test(text) ? 'engineering' : 'general'
  const outputMode = /黑白|灰度|单色|打印|复印/i.test(text) ? 'monochrome' : 'color'
  return { explicit, role, discipline, outputMode }
}

const clamp = (value, min = 0, max = 1) => Math.max(min, Math.min(max, value))
const clamp01 = (value) => clamp(value, 0, 1)

function parseHex(hex) {
  const value = String(hex).replace('#', '')
  if (!/^[0-9a-f]{6}$/i.test(value)) return [0, 0, 0]
  return [0, 2, 4].map((offset) => Number.parseInt(value.slice(offset, offset + 2), 16) / 255)
}

function hexToRgb(hex) {
  return parseHex(hex)
}

function linearChannel(value) {
  // sRGB gamma 解码：0.04045 阈值为 W3C WCAG / IEC 61966-2-1 标准
  return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4
}

function gammaEncode(value) {
  // sRGB gamma 编码（与 linearChannel 互逆）
  const v = clamp01(value)
  return v <= 0.0031308 ? 12.92 * v : 1.055 * v ** (1 / 2.4) - 0.055
}

function rgbToHex(rgb) {
  const channels = rgb.map((v) => Math.round(clamp01(v) * 255))
  return '#' + channels.map((v) => v.toString(16).padStart(2, '0')).join('').toUpperCase()
}

/** WCAG 相对亮度（linear RGB 加权，Y 通道近似） */
function relativeLuminance(hex) {
  const [r, g, b] = hexToRgb(hex).map(linearChannel)
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}

/**
 * hex → CIE L*a*b*（D65 白点）。
 * XYZ 矩阵为 sRGB→XYZ（D65）标准；f 函数为 CIE 1976 Lab 非线性。
 */
function rgbToLab(hex) {
  const [r, g, b] = hexToRgb(hex).map(linearChannel)
  const x = (0.4124564 * r + 0.3575761 * g + 0.1804375 * b) / 0.95047
  const y = 0.2126729 * r + 0.7151522 * g + 0.072175 * b
  const z = (0.0193339 * r + 0.119192 * g + 0.9503041 * b) / 1.08883
  const f = (value) => value > 216 / 24389 ? Math.cbrt(value) : (24389 / 27 * value + 16) / 116
  const fx = f(x); const fy = f(y); const fz = f(z)
  return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)]
}

/**
 * CIE L*a*b* → hex（D65）。用于 Lab 空间插值后回写 sRGB。
 */
function labToHex(lab) {
  const [L, a, b] = lab
  const fy = (L + 16) / 116
  const fx = fy + a / 500
  const fz = fy - b / 200
  const epsilon = 216 / 24389
  const kappa = 24389 / 27
  const fInv = (t) => {
    const t3 = t ** 3
    return t3 > epsilon ? t3 : (116 * t - 16) / kappa
  }
  const x = 0.95047 * fInv(fx)
  const y = 1.0 * fInv(fy)
  const z = 1.08883 * fInv(fz)
  // XYZ → linear sRGB（D65，与 rgbToLab 矩阵互逆）
  const rLin = 3.2404542 * x - 1.5371385 * y - 0.4985314 * z
  const gLin = -0.9692660 * x + 1.8760108 * y + 0.0415560 * z
  const bLin = 0.0556434 * x - 0.2040259 * y + 1.0572252 * z
  return rgbToHex([gammaEncode(rLin), gammaEncode(gLin), gammaEncode(bLin)])
}


const DEG2RAD = Math.PI / 180
const RAD2DEG = 180 / Math.PI

/**
 * CIEDE2000 色差（CIE DE2000 standard，kL=kC=kH=1）。
 * 完整实现含旋转项 RT；输入 hex，先 hex→sRGB→XYZ→Lab 再计算 ΔE00。
 * 算法来源：ISO/CIE 11664-6:2019 "Colorimetry — Part 6: CIEDE2000 colour-difference formula"。
 */
export function ciede2000(hex1, hex2) {
  const [L1, a1, b1] = rgbToLab(hex1)
  const [L2, a2, b2] = rgbToLab(hex2)

  const C1 = Math.hypot(a1, b1)
  const C2 = Math.hypot(a2, b2)
  const Cbar = (C1 + C2) / 2

  // 色度校正项 G（CIEDE2000 的 a* 轴旋转）
  const Cbar7 = Cbar ** 7
  const G = 0.5 * (1 - Math.sqrt(Cbar7 / (Cbar7 + 25 ** 7)))

  const a1p = (1 + G) * a1
  const a2p = (1 + G) * a2
  const C1p = Math.hypot(a1p, b1)
  const C2p = Math.hypot(a2p, b2)

  const hp = (a, b) => {
    if (a === 0 && b === 0) return 0
    let h = Math.atan2(b, a) * RAD2DEG
    return h < 0 ? h + 360 : h
  }
  const h1p = hp(a1p, b1)
  const h2p = hp(a2p, b2)

  const dLp = L2 - L1
  const dCp = C2p - C1p

  let dhp
  if (C1p === 0 || C2p === 0) {
    dhp = 0
  } else {
    const diff = h2p - h1p
    if (Math.abs(diff) <= 180) dhp = diff
    else if (diff > 180) dhp = diff - 360
    else dhp = diff + 360
  }
  const dHp = 2 * Math.sqrt(C1p * C2p) * Math.sin((dhp / 2) * DEG2RAD)

  const Lbarp = (L1 + L2) / 2
  const Cbarp = (C1p + C2p) / 2

  let hbarp
  if (C1p === 0 || C2p === 0) {
    hbarp = h1p + h2p
  } else if (Math.abs(h1p - h2p) <= 180) {
    hbarp = (h1p + h2p) / 2
  } else {
    hbarp = h1p + h2p < 360 ? (h1p + h2p + 360) / 2 : (h1p + h2p - 360) / 2
  }

  const T = 1
    - 0.17 * Math.cos((hbarp - 30) * DEG2RAD)
    + 0.24 * Math.cos(2 * hbarp * DEG2RAD)
    + 0.32 * Math.cos((3 * hbarp + 6) * DEG2RAD)
    - 0.20 * Math.cos((4 * hbarp - 63) * DEG2RAD)

  const dTheta = 30 * Math.exp(-(((hbarp - 275) / 25) ** 2))
  const RC = 2 * Math.sqrt(Cbarp ** 7 / (Cbarp ** 7 + 25 ** 7))
  const SL = 1 + (0.015 * (Lbarp - 50) ** 2) / Math.sqrt(20 + (Lbarp - 50) ** 2)
  const SC = 1 + 0.045 * Cbarp
  const SH = 1 + 0.015 * Cbarp * T
  const RT = -Math.sin(2 * dTheta * DEG2RAD) * RC

  const vL = dLp / SL
  const vC = dCp / SC
  const vH = dHp / SH
  return Math.sqrt(vL * vL + vC * vC + vH * vH + RT * vC * vH)
}

// ---- 色觉缺陷（CVD）模拟：Vienot 1999 / Brettel-Vienot-Mollon 矩阵 ----
// 算法来源：Vienot F., Brettel H., Mollon J.D. (1999), "Digital video colourmaps for
// checking the legibility of displays by dichromats", Color Research & Application 24(4).
// 流程：linear RGB → LMS（Hunt-Pointer-Estevez，D65 归一化）→ 异常 LMS 矩阵 → linear RGB → sRGB。

// RGB(linear) → LMS 变换矩阵（Hunt D65，Vienot 1999 引用）
const RGB_TO_LMS = [
  [0.31399022, 0.63951264, 0.04649752],
  [0.15537151, 0.75789446, 0.08670142],
  [0.02872603, 0.14670800, 0.92074258]
]

// 三色盲（二色觉）在 LMS 空间的投影矩阵
const CVD_MATRICES = {
  // 红色盲（L 锥缺失）
  protan: [
    [0.0, 2.02344, -2.52581],
    [0.0, 1.0, 0.0],
    [0.0, 0.0, 1.0]
  ],
  // 绿色盲（M 锥缺失）
  deutan: [
    [1.0, 0.0, 0.0],
    [0.494207, 0.0, 1.24827],
    [0.0, 0.0, 1.0]
  ],
  // 蓝色盲（S 锥缺失）
  tritan: [
    [1.0, 0.0, 0.0],
    [0.0, 1.0, 0.0],
    [-0.395913, 0.801109, 0.0]
  ]
}

function matVec(m, v) {
  return m.map((row) => row[0] * v[0] + row[1] * v[1] + row[2] * v[2])
}

/** 3x3 矩阵求逆（仅用于固定小矩阵，零依赖实现） */
function invert3(m) {
  const [a, b, c] = m[0]
  const [d, e, f] = m[1]
  const [g, h, i] = m[2]
  const A = e * i - f * h
  const B = -(d * i - f * g)
  const C = d * h - e * g
  const det = a * A + b * B + c * C
  return [
    [A / det, (c * h - b * i) / det, (b * f - c * e) / det],
    [B / det, (a * i - c * g) / det, (c * d - a * f) / det],
    [C / det, (b * g - a * h) / det, (a * e - b * d) / det]
  ]
}

const LMS_TO_RGB = invert3(RGB_TO_LMS)

function simulateCvd(hex, kind) {
  const rgb = parseHex(hex).map(linearChannel)
  const lms = matVec(RGB_TO_LMS, rgb)
  const lmsSim = matVec(CVD_MATRICES[kind], lms)
  const rgbSim = matVec(LMS_TO_RGB, lmsSim)
  return rgbToHex(rgbSim)
}

/** 红色盲（protanopia）模拟，返回合法 hex */
export function simulateProtan(hex) {
  return simulateCvd(hex, 'protan')
}

/** 绿色盲（deuteranopia）模拟，返回合法 hex */
export function simulateDeutan(hex) {
  return simulateCvd(hex, 'deutan')
}

/** 蓝色盲（tritanopia）模拟，返回合法 hex */
export function simulateTritan(hex) {
  return simulateCvd(hex, 'tritan')
}

/**
 * 灰度（WCAG 相对亮度）距离。
 * 返回两个颜色在线性亮度意义上的相对亮度差 |L1 - L2|（0~1）。
 */
export function grayscaleDistance(hex1, hex2) {
  return Math.abs(relativeLuminance(hex1) - relativeLuminance(hex2))
}

/**
 * 在 Lab 空间对两个 hex 做线性插值，返回中间色 hex。
 * t=0 返回 a，t=1 返回 b。用于色板容量不足时动态补色。
 */
function interpolateLab(hexA, hexB, t) {
  const labA = rgbToLab(hexA)
  const labB = rgbToLab(hexB)
  const lab = labA.map((v, i) => v + (labB[i] - v) * t)
  return labToHex(lab)
}

/**
 * 色板容量不足时，在相邻原色之间插值扩展到 need 个颜色。
 * 返回 { colors, interpolatedCount }；新增颜色标记为插值色。
 */
function extendColors(original, need) {
  if (need <= original.length) return { colors: original.slice(0, need), interpolatedCount: 0, interpolated: false }
  const colors = original.slice()
  // 在相邻色之间等距插入，循环遍历相邻对直到补足 need
  let guard = 0
  while (colors.length < need && guard < 1000) {
    guard += 1
    const next = []
    let inserted = false
    for (let i = 0; i < colors.length; i += 1) {
      next.push(colors[i])
      if (colors.length < need && i + 1 < colors.length) {
        next.push(interpolateLab(colors[i], colors[i + 1], 0.5))
        inserted = true
      } else if (colors.length < need && i + 1 === colors.length) {
        // 末尾回绕到首色插一色
        next.push(interpolateLab(colors[i], colors[0], 0.5))
        inserted = true
      }
    }
    colors.length = 0
    colors.push(...next)
    if (!inserted) break
  }
  const interpolatedCount = Math.max(0, colors.length - original.length)
  return { colors: colors.slice(0, need), interpolatedCount, interpolated: interpolatedCount > 0 }
}

const CVD_PASSED_THRESHOLD = 10
const GRAYSCALE_PASS_THRESHOLD = 0.15

export function paletteMetrics(palette, seriesCount = 1) {
  const count = Math.max(1, Math.floor(seriesCount || 1))
  const used = palette.colors.slice(0, Math.min(count, palette.colors.length))
  const luminances = used.map(relativeLuminance)
  const deltaE00 = [] // CIEDE2000 逐对色差（可辨性主度量）
  const cvdDeltaE00 = [] // 三种 CVD 模拟下逐对 CIEDE2000
  const luminanceGaps = []
  for (let i = 0; i < used.length; i += 1) {
    for (let j = i + 1; j < used.length; j += 1) {
      deltaE00.push(ciede2000(used[i], used[j]))
      luminanceGaps.push(Math.abs(luminances[i] - luminances[j]))
      // 对每对颜色在 protan/deutan/tritan 下分别计算 ΔE00（模拟后两色之间）
      for (const sim of [simulateProtan, simulateDeutan, simulateTritan]) {
        cvdDeltaE00.push(ciede2000(sim(used[i]), sim(used[j])))
      }
    }
  }
  const steps = luminances.slice(1).map((value, index) => value - luminances[index])
  const positive = steps.filter((value) => value >= -0.01).length
  const negative = steps.filter((value) => value <= 0.01).length
  const endpointMean = luminances.length > 1 ? (luminances[0] + luminances.at(-1)) / 2 : luminances[0]
  const center = luminances[Math.floor(luminances.length / 2)] ?? luminances[0]
  const minCvdDeltaE = cvdDeltaE00.length ? Math.min(...cvdDeltaE00) : 100
  const minGrayscaleGap = luminanceGaps.length ? Math.min(...luminanceGaps) : 1
  return {
    capacity: palette.colors.length,
    overflow: Math.max(0, count - palette.colors.length),
    // V2：minDeltaE 改用 CIEDE2000（保留字段名兼容）
    minDeltaE: deltaE00.length ? Math.min(...deltaE00) : 100,
    minCvdDeltaE,
    cvdPass: minCvdDeltaE >= CVD_PASSED_THRESHOLD,
    minGrayscaleGap,
    grayscalePass: minGrayscaleGap >= GRAYSCALE_PASS_THRESHOLD,
    minLuminanceGap: luminanceGaps.length ? Math.min(...luminanceGaps) : 1,
    luminanceRange: luminances.length ? Math.max(...luminances) - Math.min(...luminances) : 0,
    monotonicity: steps.length ? Math.max(positive, negative) / steps.length : 1,
    divergingCenterLift: center == null || endpointMean == null ? 0 : center - endpointMean,
    minContrastOnWhite: luminances.length ? Math.min(...luminances.map((value) => 1.05 / (value + 0.05))) : 1
  }
}

function preferenceScore(id, events = [], now = Date.now()) {
  let score = 0
  for (const event of events) {
    if (event.reverted || event.paletteId !== id) continue
    const sign = event.kind === 'reject' ? -1 : event.kind === 'browse' ? 0.1 : 1
    const ageDays = Math.max(0, now - (event.t ?? now)) / 86_400_000
    score += sign * (event.weight ?? 0.5) * (event.confidence ?? 0.7) * Math.exp(-ageDays / 90)
  }
  // 偏好只作为有界先验，不能压过可读性、色板容量和图表语义。
  return 1.5 * Math.tanh(score / 2)
}

/** 组装冗余编码信息（溢出或灰度/CVD 不通过时启用） */
function redundantEncodingFor(metrics, seriesCount) {
  const overflow = metrics.overflow > 0
  const grayscaleWeak = metrics.minGrayscaleGap < GRAYSCALE_PASS_THRESHOLD
  const cvdWeak = !metrics.cvdPass
  const enabled = overflow || grayscaleWeak || cvdWeak
  return {
    enabled,
    lineStyles: enabled ? [...REDUNDANT_LINE_STYLES] : [],
    markers: enabled ? [...REDUNDANT_MARKERS] : [],
    reason: overflow
      ? `系列数 ${seriesCount} 超过色板容量 ${metrics.capacity}，已启用冗余编码（线型/点型差异），建议分面或筛选`
      : grayscaleWeak
        ? '灰度最小亮度差不足 0.15，已建议线型/点型冗余编码以保证黑白打印可辨'
        : '色觉缺陷模拟下色差不足，已建议线型/点型冗余编码'
  }
}

export function recommendPalette({ prompt = '', chartType = '', strategy = 'clarity', preferenceEvents = [], seriesCount = 1, userProfile = null, now = Date.now() } = {}) {
  const request = parseRequest(`${prompt} ${chartType}`)
  if (request.explicit && PALETTE_LIBRARY[request.explicit]) {
    const palette = PALETTE_LIBRARY[request.explicit]
    const metrics = paletteMetrics(palette, seriesCount)
    const redundant = redundantEncodingFor(metrics, seriesCount)
    const warnings = []
    if (metrics.overflow > 0) warnings.push(redundant.reason)
    if (!metrics.cvdPass) warnings.push(`色觉缺陷模拟下最小 ΔE00=${metrics.minCvdDeltaE.toFixed(1)} < 10，建议叠加线型/点型差异。`)
    // 溢出不循环：Lab 插值补色，而非复用第 i % M 色
    const ext = extendColors(palette.colors, seriesCount)
    return {
      ...palette,
      colors: ext.colors,
      metrics,
      warnings,
      redundantEncoding: { enabled: redundant.enabled, lineStyles: redundant.lineStyles, markers: redundant.markers },
      interpolated: ext.interpolated,
      interpolatedCount: ext.interpolatedCount,
      scoreBreakdown: { explicit: true },
      reason: `采用用户在开始菜单中指定的配色预设。${warnings[0] ?? ''}`
    }
  }
  const role = /heatmap|相关|热力/i.test(chartType) ? 'diverging' : request.role
  const scored = Object.values(PALETTE_LIBRARY).map((palette) => {
    const metrics = paletteMetrics(palette, seriesCount)
    const preference = preferenceScore(palette.id, preferenceEvents, now)
    // 学习模型先验（colorLearning.profilePaletteScore）：有界 tanh 先验，仅作微调，不压过硬约束
    const learned = userProfile ? profilePaletteScore(userProfile, palette.id, chartType) : 0
    const semantic = (palette.roles.includes(role) ? 2.4 : 0) + (palette.roles.includes(request.discipline) ? 1.2 : 0)
    const strategyFit = (strategy === 'convention' && palette.roles.includes('publication') ? 1.1 : 0) +
      (strategy === 'clarity' && palette.roles.includes('accessibility') ? 0.9 : 0)
    // 容量不足改为扣分 + 启用冗余编码，不再通过循环复用颜色"凑满"系列
    const capacity = metrics.overflow ? -2.5 - 0.4 * metrics.overflow : Math.min(0.7, (metrics.capacity - seriesCount + 1) * 0.12)
    const perceptual = role === 'sequential'
      ? 0.9 * metrics.monotonicity + 0.5 * clamp(metrics.luminanceRange / 0.65)
      : role === 'diverging'
        ? 0.9 * clamp(metrics.divergingCenterLift / 0.55) + 0.4 * clamp(metrics.luminanceRange / 0.65)
        : 1.2 * clamp((metrics.minDeltaE - 10) / 35) + 0.35 * clamp((metrics.minContrastOnWhite - 1.4) / 2.6)
    const monochrome = request.outputMode === 'monochrome'
      ? 1.4 * clamp(metrics.luminanceRange / 0.65) + 0.8 * clamp(metrics.minLuminanceGap / 0.22)
      : 0
    // 可访问性不是附加装饰：将 CVD 与灰度通过情况纳入总分，避免仅凭“好看/历史偏好”推荐难以辨认的色板。
    const accessibility = 0.75 * (metrics.cvdPass ? 1 : 0) +
      0.45 * (metrics.grayscalePass ? 1 : 0) +
      0.30 * clamp((metrics.minContrastOnWhite - 1.4) / 2.6)
    const provenance = palette.source === 'user' ? 0.35 : 0
    const breakdown = { semantic, strategyFit, capacity, perceptual, accessibility, monochrome, preference, learned, provenance }
    const score = Object.values(breakdown).reduce((sum, value) => sum + value, 0)
    return { palette, score, metrics, breakdown }
  }).sort((a, b) => b.score - a.score || a.palette.id.localeCompare(b.palette.id))
  const winner = scored[0] ?? { palette: PALETTE_LIBRARY[USER_IDS[1]], metrics: paletteMetrics(PALETTE_LIBRARY[USER_IDS[1]], seriesCount), breakdown: {} }
  const chosen = winner.palette
  const metrics = winner.metrics
  const redundant = redundantEncodingFor(metrics, seriesCount)
  const warnings = []
  if (metrics.overflow > 0) warnings.push(redundant.reason)
  if (!metrics.cvdPass) warnings.push(`色觉缺陷模拟下最小 ΔE00=${metrics.minCvdDeltaE.toFixed(1)} < 10，建议叠加线型/点型差异。`)
  const ext = extendColors(chosen.colors, seriesCount)
  const preferencePhrase = Math.abs(winner.breakdown.preference ?? 0) >= 0.15 ? '，并结合了近期个人选择' : ''
  const learnedPhrase = Math.abs(winner.breakdown.learned ?? 0) >= 0.1 ? '，并依据你的历史配色偏好动态调整' : ''
  const modePhrase = request.outputMode === 'monochrome' ? '，同时提高灰度打印区分度' : ''
  return {
    ...chosen,
    colors: ext.colors,
    metrics,
    warnings,
    redundantEncoding: { enabled: redundant.enabled, lineStyles: redundant.lineStyles, markers: redundant.markers },
    interpolated: ext.interpolated,
    interpolatedCount: ext.interpolatedCount,
    scoreBreakdown: winner.breakdown,
    learned: winner.breakdown.learned ?? 0,
    reason: `按${role === 'diverging' ? '正负差异' : role === 'sequential' ? '连续强度' : role === 'paired' ? '成对对照' : '分类比较'}用途、${request.discipline === 'medicine' ? '医学' : request.discipline === 'environment' ? '环境与生命' : request.discipline === 'engineering' ? '工程' : '通用'}场景、${seriesCount} 个系列、CVD/灰度可辨性和颜色对比度综合推荐${preferencePhrase}${learnedPhrase}${modePhrase}。`
  }
}


