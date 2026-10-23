import { describe, expect, it } from 'vitest'
import { CONFIG } from '../src/game/config'
import { ANCHORS, SEGMENT_REALMS, routeLayout, rng } from '../src/game/world'

const apex = CONFIG.player.jumpSpeed ** 2 / (2 * Math.abs(CONFIG.player.gravity))
const airtime = (2 * CONFIG.player.jumpSpeed) / Math.abs(CONFIG.player.gravity)
const reach = CONFIG.player.walkSpeed * airtime

describe('GLITCHVERSE route', () => {
  it('keeps each dimension-gated bridge within the controller jump envelope', () => {
    const layout = routeLayout()
    for (let segment = 0; segment < SEGMENT_REALMS.length; segment += 1) {
      const route = layout.filter(piece => piece.segment === segment).sort((a, b) => a.step - b.step)
      expect(route).toHaveLength(5)
      expect(route.every(piece => piece.realm === SEGMENT_REALMS[segment])).toBe(true)
      const hops = [
        { centerX: ANCHORS[segment], width: 6.2, top: layout.find(piece => piece.realm === null && piece.step === segment)!.top },
        ...route,
        { centerX: ANCHORS[segment + 1], width: 6.2, top: layout.find(piece => piece.realm === null && piece.step === segment + 1)!.top },
      ]
      for (let i = 1; i < hops.length; i += 1) {
        const previous = hops[i - 1]
        const current = hops[i]
        const gap = Math.max(0, current.centerX - previous.centerX - (current.width + previous.width) / 2)
        expect(gap).toBeLessThan(reach * 0.8)
        expect(Math.abs(current.top - previous.top)).toBeLessThan(apex * 0.75)
      }
    }
  })

  it('alternates between the two distinct route layers and shares switch-safe anchors', () => {
    const layout = routeLayout()
    expect(SEGMENT_REALMS).toEqual([0, 1, 0, 1, 0])
    for (let i = 0; i < ANCHORS.length; i += 1) {
      expect(layout.find(piece => piece.segment === -1 && piece.step === i)).toMatchObject({ centerX: ANCHORS[i], realm: null, width: 6.2 })
    }
    expect(layout.filter(piece => piece.realm === 0)).toHaveLength(15)
    expect(layout.filter(piece => piece.realm === 1)).toHaveLength(10)
  })

  it('uses a deterministic random stream for the procedural scenery', () => {
    const a = rng(7)
    const b = rng(7)
    for (let i = 0; i < 20; i += 1) expect(a()).toBe(b())
  })
})
