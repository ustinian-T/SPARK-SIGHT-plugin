import { describe, expect, it } from 'vitest'
import { PALETTE_SWATCHES } from './PaletteSelect'

describe('palette swatch catalog', () => {
  it('has distinct, valid color samples for all user-facing palette presets', () => {
    for (const id of ['user_ocean', 'user_garden', 'user_nature', 'user_macaron', 'user_pairs', 'okabe_ito', 'paultol_bright', 'paultol_muted', 'ggsci_npg', 'ggsci_nejm', 'brewer_diverging', 'brewer_sequential', 'viridis_like', 'magma_like']) {
      const palette = PALETTE_SWATCHES[id]
      expect(palette?.colors.length).toBeGreaterThanOrEqual(5)
      expect(palette?.colors.every((color) => /^#[0-9A-F]{6}$/i.test(color))).toBe(true)
      expect(new Set(palette?.colors).size).toBe(palette?.colors.length)
    }
  })
})
