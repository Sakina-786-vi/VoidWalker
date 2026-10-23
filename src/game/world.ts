import * as THREE from 'three'
import { Physics, RAPIER } from '../engine/physics'

export type Dimension = 0 | 1
export type DroneRoute = { center: THREE.Vector3; radius: number; phase: number; dir: number }
export type Platform = {
  centerX: number
  width: number
  top: number
  realm: Dimension | null
}
type SurfaceRecord = Platform & { normal: RAPIER.Collider; inverted: RAPIER.Collider }
type MovingHazard = {
  mesh: THREE.Group
  realm: Dimension
  x: number
  y: number
  phase: number
  speed: number
  sway: number
  radius: number
}

const FLIP_Y = 12
const THICKNESS = 0.72
const DEPTH = 4.8
const PLAYER_HALF = 0.92
export const ANCHORS = [0, 18, 36, 54, 72, 90] as const
export const ANCHOR_TOPS = [0, 0.55, 0.05, 0.78, 0.28, 0.95] as const
export const SEGMENT_REALMS: Dimension[] = [0, 1, 0, 1, 0]
export const CHECKPOINTS = [0, 2, 4, 5] as const

export type RoutePiece = Platform & { segment: number; step: number }

/** Shared pure geometry so route validation exercises exactly the bridges used by the scene. */
export function routeLayout(): RoutePiece[] {
  const pieces: RoutePiece[] = ANCHORS.map((centerX, step) => ({ centerX, width: 6.2, top: ANCHOR_TOPS[step], realm: null, segment: -1, step }))
  for (let segment = 0; segment < SEGMENT_REALMS.length; segment += 1) {
    const realm = SEGMENT_REALMS[segment]
    const startX = ANCHORS[segment]
    const endX = ANCHORS[segment + 1]
    const startTop = ANCHOR_TOPS[segment]
    const endTop = ANCHOR_TOPS[segment + 1]
    for (let step = 1; step <= 5; step += 1) {
      const k = step / 6
      pieces.push({
        centerX: startX + k * (endX - startX),
        width: step === 1 || step === 5 ? 2.9 : 2.55,
        top: THREE.MathUtils.lerp(startTop, endTop, k) + Math.sin(k * Math.PI) * (segment % 2 ? -0.22 : 0.22),
        realm,
        segment,
        step,
      })
    }
  }
  return pieces
}

const palette = {
  future: { sky: '#090b19', fog: '#131b30', key: '#b1d6ff', fill: '#302c4c', glow: '#8b61ff', trim: '#42e8ff', hot: '#ff4ca5' },
  fantasy: { sky: '#071510', fog: '#102824', key: '#a9ffeb', fill: '#1d3c38', glow: '#41e3c1', trim: '#54f4cf', hot: '#ba74ff' },
}
const boxGeo = new THREE.BoxGeometry(1, 1, 1)
const sphereGeo = new THREE.SphereGeometry(1, 16, 12)
const glowMat = (color: string, intensity = 2) => new THREE.MeshStandardMaterial({ color, emissive: color, emissiveIntensity: intensity, roughness: 0.28, metalness: 0.3 })
const flatMat = (color: string, roughness = 0.7, metalness = 0.08) => new THREE.MeshStandardMaterial({ color, roughness, metalness, flatShading: true })

/** Side-scroll world containing two independently lit and collidable dimension layers. */
export class World {
  readonly scene = new THREE.Scene()
  readonly sun: THREE.DirectionalLight
  readonly spawn = new THREE.Vector3(0, PLAYER_HALF, 0)
  readonly coreSpotsByDimension: [THREE.Vector3[], THREE.Vector3[]] = [[], []]
  readonly checkpointXs = CHECKPOINTS.map(index => ANCHORS[index])
  private readonly future = new THREE.Group()
  private readonly fantasy = new THREE.Group()
  private readonly shared = new THREE.Group()
  private readonly platforms: SurfaceRecord[] = []
  private readonly hazards: MovingHazard[] = []
  private readonly atmosphere: THREE.Points[] = []
  private readonly backgroundColor = new THREE.Color(palette.future.sky)
  private readonly targetBackground = new THREE.Color(palette.future.sky)
  private readonly fogColor = new THREE.Color(palette.future.fog)
  private readonly targetFog = new THREE.Color(palette.future.fog)
  private readonly targetSunColor = new THREE.Color(palette.future.key)
  private readonly targetGlow = new THREE.Color(palette.future.glow)
  private readonly targetHemiColor = new THREE.Color('#b7ccff')
  private readonly targetGroundColor = new THREE.Color('#141a28')
  private readonly hemisphere = new THREE.HemisphereLight('#b7ccff', '#151a28', 1.2)
  private targetSunIntensity = 2.45
  private targetHemiIntensity = 1.2
  private readonly flashLights: THREE.PointLight[] = []
  private readonly driftingSprites: Array<{ sprite: THREE.Sprite; x: number; y: number; amplitude: number; speed: number; phase: number; opacity: number }> = []
  private readonly meteors: THREE.Group[] = []
  private readonly satellites: THREE.Group[] = []
  private readonly winged: Array<{ group: THREE.Group; x: number; y: number; speed: number; phase: number }> = []
  private readonly electricArcs: THREE.Line[] = []
  private readonly auroras: THREE.ShaderMaterial[] = []
  private ambienceTime = 0
  private time = 0
  private transition = 1
  currentDimension: Dimension = 0
  readonly requiredRoute: readonly Dimension[] = SEGMENT_REALMS
  readonly gravityFlipY = FLIP_Y
  readonly playerHalfHeight = PLAYER_HALF

  constructor(private readonly physics: Physics, shadowMapSize: number) {
    this.scene.background = this.backgroundColor
    this.scene.fog = new THREE.FogExp2(palette.future.fog, 0.006)
    this.scene.add(this.future, this.fantasy, this.shared)

    this.scene.add(this.hemisphere)
    this.sun = new THREE.DirectionalLight(palette.future.key, 2.3)
    this.sun.castShadow = true
    this.sun.shadow.mapSize.set(shadowMapSize, shadowMapSize)
    this.sun.shadow.camera.left = -28
    this.sun.shadow.camera.right = 28
    this.sun.shadow.camera.top = 22
    this.sun.shadow.camera.bottom = -14
    this.sun.shadow.camera.near = 1
    this.sun.shadow.camera.far = 100
    this.sun.shadow.bias = -0.0003
    this.sun.shadow.normalBias = 0.035
    this.scene.add(this.sun, this.sun.target)
    this.addStarfield()
    this.buildFuture()
    this.buildFantasy()
    this.buildRoutes()
    this.buildHazards()
    this.setDimension(0, true)
  }

  setDimension(dimension: Dimension, instant = false): void {
    this.currentDimension = dimension
    this.future.visible = dimension === 0
    this.fantasy.visible = dimension === 1
    for (const platform of this.platforms) {
      const enabled = platform.realm === null || platform.realm === dimension
      platform.normal.setEnabled(enabled)
      platform.inverted.setEnabled(enabled)
    }
    const target = dimension === 0 ? palette.future : palette.fantasy
    this.targetBackground.set(target.sky)
    this.targetFog.set(target.fog)
    this.targetSunColor.set(target.key)
    this.targetGlow.set(target.glow)
    this.targetSunIntensity = dimension === 0 ? 2.45 : 2.3
    this.targetHemiColor.set(target.key)
    this.targetGroundColor.set(dimension === 0 ? '#141a28' : '#123029')
    this.targetHemiIntensity = dimension === 0 ? 1.2 : 1.28
    if (instant) {
      this.backgroundColor.copy(this.targetBackground)
      this.fogColor.copy(this.targetFog)
      this.sun.color.copy(this.targetSunColor)
      this.sun.intensity = this.targetSunIntensity
      this.hemisphere.color.copy(this.targetHemiColor)
      this.hemisphere.groundColor.copy(this.targetGroundColor)
      this.hemisphere.intensity = this.targetHemiIntensity
      for (const light of this.flashLights) light.color.copy(this.targetGlow)
      this.transition = 1
    } else this.transition = 0
  }

  /** A switch is allowed only on a real floor/ceiling in the destination phase. */
  isSafeAt(position: THREE.Vector3, dimension: Dimension, gravitySign: 1 | -1): boolean {
    const surface = position.y - gravitySign * PLAYER_HALF
    return this.platforms.some(platform => {
      if (platform.realm !== null && platform.realm !== dimension) return false
      const expected = gravitySign > 0 ? platform.top : FLIP_Y - platform.top
      return Math.abs(expected - surface) < 0.36 && Math.abs(position.x - platform.centerX) < platform.width / 2 + 0.15 && Math.abs(position.z) < DEPTH / 2 - 0.2
    })
  }

  supportAt(position: THREE.Vector3, dimension: Dimension, gravitySign: 1 | -1): number | null {
    const surface = position.y - gravitySign * PLAYER_HALF
    let best: number | null = null
    let bestDistance = Infinity
    for (const platform of this.platforms) {
      if (platform.realm !== null && platform.realm !== dimension) continue
      if (Math.abs(position.x - platform.centerX) > platform.width / 2 + 0.05 || Math.abs(position.z) > DEPTH / 2 - 0.12) continue
      const height = gravitySign > 0 ? platform.top : FLIP_Y - platform.top
      const difference = Math.abs(height - surface)
      if (difference < 0.42 && difference < bestDistance) {
        best = height
        bestDistance = difference
      }
    }
    return best
  }

  anchorPosition(index: number, dimension: Dimension, gravitySign: 1 | -1): THREE.Vector3 {
    void dimension
    const safeIndex = THREE.MathUtils.clamp(index, 0, ANCHORS.length - 1)
    const top = ANCHOR_TOPS[safeIndex]
    const surface = gravitySign > 0 ? top : FLIP_Y - top
    return new THREE.Vector3(ANCHORS[safeIndex], surface + gravitySign * PLAYER_HALF, 0)
  }

  checkpointAtOrBefore(x: number): number {
    let chosen = 0
    for (let i = 0; i < CHECKPOINTS.length; i += 1) {
      if (x >= ANCHORS[CHECKPOINTS[i]] - 0.7) chosen = i
    }
    return chosen
  }

  checkpointAnchorIndex(checkpointNumber: number): number {
    return CHECKPOINTS[THREE.MathUtils.clamp(checkpointNumber, 0, CHECKPOINTS.length - 1)]
  }

  nextRequiredDimension(x: number): Dimension {
    const segment = THREE.MathUtils.clamp(Math.floor((x + 0.001) / 18), 0, SEGMENT_REALMS.length - 1)
    return SEGMENT_REALMS[segment]
  }

  /** Fixed-step simulation for selected moving hazards; T freezes them without pausing the world. */
  stepHazards(dt: number, frozen: boolean): void {
    if (frozen) return
    this.time += dt
    for (const hazard of this.hazards) {
      const t = this.time * hazard.speed + hazard.phase
      hazard.mesh.position.set(hazard.x + Math.sin(t) * hazard.sway, hazard.y + Math.sin(t * 2.2) * 0.34, 0.35)
      hazard.mesh.rotation.z += dt * 1.1
    }
  }

  hazardPositions(dimension: Dimension): THREE.Vector3[] {
    return this.hazards.filter(h => h.realm === dimension).map(h => h.mesh.position)
  }

  /** Frame ambience, world-colour transition, and parallax light motion. */
  update(frameSeconds: number, focus: THREE.Vector3): void {
    this.time += frameSeconds * 0.12
    this.ambienceTime += frameSeconds
    this.transition = Math.min(1, this.transition + frameSeconds * 2.8)
    const blend = 1 - Math.exp(-frameSeconds * 3.2)
    this.backgroundColor.lerp(this.targetBackground, blend)
    this.fogColor.lerp(this.targetFog, blend)
    this.sun.color.lerp(this.targetSunColor, blend)
    this.sun.intensity = THREE.MathUtils.damp(this.sun.intensity, this.targetSunIntensity, 3.2, frameSeconds)
    this.hemisphere.color.lerp(this.targetHemiColor, blend)
    this.hemisphere.groundColor.lerp(this.targetGroundColor, blend)
    this.hemisphere.intensity = THREE.MathUtils.damp(this.hemisphere.intensity, this.targetHemiIntensity, 3.2, frameSeconds)
    for (const light of this.flashLights) light.color.lerp(this.targetGlow, blend)
    const fog = this.scene.fog as THREE.FogExp2
    fog.color.copy(this.fogColor)
    this.sun.position.set(focus.x + 6, focus.y + 25, 18)
    this.sun.target.position.set(focus.x + 2, focus.y, 0)
    for (let i = 0; i < this.flashLights.length; i += 1) {
      const light = this.flashLights[i]
      light.intensity = 0.25 + (0.5 + 0.5 * Math.sin(this.time * (2.8 + i * 0.7) + i)) * 1.2
      light.position.x += Math.sin(this.time * 0.7 + i) * frameSeconds * 0.18
    }
    for (let i = 0; i < this.atmosphere.length; i += 1) {
      const points = this.atmosphere[i]
      const mat = points.material as THREE.PointsMaterial
      mat.opacity = 0.56 + Math.sin(this.time * (1.2 + i * 0.1)) * 0.18
    }
    for (const meteor of this.meteors) {
      const t = (this.ambienceTime * 1.35 + Number(meteor.userData.phase)) % 44
      meteor.position.set(Number(meteor.userData.originX) + t * 1.45, Number(meteor.userData.originY) - t * 0.58, -31)
      meteor.rotation.z = -0.24
    }
    for (const satellite of this.satellites) {
      satellite.rotation.y += frameSeconds * 0.08
      satellite.rotation.z += frameSeconds * 0.035
    }
    for (const drift of this.driftingSprites) {
      const wave = this.ambienceTime * drift.speed + drift.phase
      drift.sprite.position.x = drift.x + Math.sin(wave) * drift.amplitude
      drift.sprite.position.y = drift.y + Math.sin(wave * 0.65) * 0.42
      ;(drift.sprite.material as THREE.SpriteMaterial).opacity = drift.opacity * (0.82 + 0.18 * Math.sin(wave * 1.4))
    }
    for (const flyer of this.winged) {
      const wave = this.ambienceTime * flyer.speed + flyer.phase
      flyer.group.position.set(flyer.x + Math.sin(wave) * 4.2, flyer.y + Math.sin(wave * 1.5) * 0.48, -18)
      flyer.group.rotation.z = Math.sin(wave * 2.2) * 0.07
    }
    for (const arc of this.electricArcs) {
      const pulse = Math.max(0, Math.sin(this.ambienceTime * 5.4 + Number(arc.userData.phase)))
      arc.visible = pulse > 0.18
      ;(arc.material as THREE.LineBasicMaterial).opacity = 0.08 + pulse * 0.72
    }
    for (const aurora of this.auroras) aurora.uniforms.uTime.value = this.ambienceTime
  }

  /** Legacy hook retained so the fixed loop can keep a distinct world-step boundary. */
  stepMovers(_elapsed: number): void {}

  private buildRoutes(): void {
    for (const piece of routeLayout()) {
      const { centerX: x, width, top, realm, segment, step } = piece
      if (realm === null) {
        this.platforms.push(this.addCollisionSurface(piece))
        this.makePlatform(this.future, x, top, width, 0, true)
        this.makePlatform(this.fantasy, x, top, width, 1, true)
        this.addAnchorGate(this.future, x, top, 0, step)
        this.addAnchorGate(this.fantasy, x, top, 1, step)
        continue
      }
      this.platforms.push(this.addCollisionSurface(piece))
      this.makePlatform(realm === 0 ? this.future : this.fantasy, x, top, width, realm, false)
      if (step === 2 || step === 4) this.coreSpotsByDimension[realm].push(new THREE.Vector3(x, top + 1.24, 0))
      if (step === 3 && segment % 2 === 0) this.addCircuitBeacon(this.future, x, top)
      if (step === 3 && segment % 2 === 1) this.addRuneSeal(this.fantasy, x, top)
    }
  }

  private addCollisionSurface(platform: Platform): SurfaceRecord {
    const normal = this.physics.addStaticBox(
      new THREE.Vector3(platform.centerX, platform.top - THICKNESS / 2, 0),
      new THREE.Vector3(platform.width, THICKNESS, DEPTH),
    )
    const inverted = this.physics.addStaticBox(
      new THREE.Vector3(platform.centerX, FLIP_Y - platform.top + THICKNESS / 2, 0),
      new THREE.Vector3(platform.width, THICKNESS, DEPTH),
    )
    if (platform.realm !== null && platform.realm !== this.currentDimension) {
      normal.setEnabled(false)
      inverted.setEnabled(false)
    }
    return { ...platform, normal, inverted }
  }

  private makePlatform(group: THREE.Group, x: number, top: number, width: number, realm: Dimension, anchor: boolean): void {
    const futureStyle = realm === 0
    const base = new THREE.Mesh(boxGeo, flatMat(futureStyle ? '#25364b' : '#344a45', futureStyle ? 0.32 : 0.86, futureStyle ? 0.82 : 0.06))
    base.scale.set(width, THICKNESS, DEPTH)
    base.position.set(x, top - THICKNESS / 2, 0)
    base.castShadow = base.receiveShadow = true
    group.add(base)

    const deckColor = futureStyle ? '#3a4f66' : '#5a6a65'
    const deck = new THREE.Mesh(boxGeo, flatMat(deckColor, futureStyle ? 0.34 : 0.88, futureStyle ? 0.74 : 0.08))
    deck.scale.set(width - 0.12, 0.1, DEPTH - 0.14)
    deck.position.set(x, top - 0.04, 0)
    deck.receiveShadow = true
    group.add(deck)

    if (futureStyle) {
      const glow = realm === 0 ? '#48e4ff' : '#65f6d3'
      const edgeMaterial = glowMat(glow, anchor ? 1.45 : 0.8)
      const edge = new THREE.Mesh(boxGeo, edgeMaterial)
      edge.scale.set(width - 0.16, 0.055, 0.095)
      edge.position.set(x, top - 0.12, 2.27)
      group.add(edge)
      const edgeBack = edge.clone()
      edgeBack.position.z = -2.27
      group.add(edgeBack)
      const count = Math.max(2, Math.floor(width / 0.88))
      for (let i = 0; i < count; i += 1) {
        const seam = new THREE.Mesh(boxGeo, flatMat(i % 3 === 0 ? '#536276' : '#111725', 0.42, 0.7))
        seam.scale.set(0.035, 0.025, DEPTH - 0.4)
        seam.position.set(x - width / 2 + (i + 0.5) * width / count, top + 0.014, 0)
        group.add(seam)
      }
      for (const z of [-2.38, 2.38]) {
        const cable = new THREE.Mesh(new THREE.CylinderGeometry(0.055, 0.055, width * 0.92, 8), glowMat('#bd52ff', 0.8))
        cable.rotation.z = Math.PI / 2
        cable.position.set(x, top - 0.46, z)
        group.add(cable)
      }
      if (anchor) {
        const console = new THREE.Mesh(boxGeo, flatMat('#151b2b', 0.28, 0.72))
        console.scale.set(0.66, 0.62, 0.82)
        console.position.set(x - width * 0.29, top + 0.3, 1.28)
        group.add(console)
        const screen = new THREE.Mesh(boxGeo, glowMat('#9a62ff', 1.1))
        screen.scale.set(0.44, 0.025, 0.52)
        screen.position.set(console.position.x, top + 0.63, 1.28)
        group.add(screen)
      } else {
        const stripe = new THREE.Mesh(boxGeo, flatMat('#e0b749', 0.48, 0.35))
        stripe.scale.set(0.6, 0.025, 0.24)
        stripe.position.set(x - width * 0.2, top + 0.023, -0.45)
        stripe.rotation.y = -0.25
        group.add(stripe)
      }
      this.addCracks(group, x, top, width, '#7d91a6')
    } else {
      const moss = new THREE.Mesh(boxGeo, flatMat('#334b40', 0.94, 0.02))
      moss.scale.set(width * 0.84, 0.08, DEPTH * 0.76)
      moss.position.set(x, top + 0.04, 0)
      group.add(moss)
      for (let n = 0; n < 3; n += 1) {
        const rune = new THREE.Mesh(new THREE.TorusGeometry(0.2 + n * 0.12, 0.024, 5, 18), glowMat('#52e5c3', 1.0))
        rune.rotation.x = Math.PI / 2
        rune.position.set(x + (n - 1) * width * 0.2, top + 0.1, 0.7 + n * 0.1)
        rune.scale.set(1, 0.5, 1)
        group.add(rune)
      }
      const crystal = new THREE.Mesh(new THREE.OctahedronGeometry(0.24, 0), glowMat('#58edcf', 1.6))
      crystal.scale.y = 1.9
      crystal.position.set(x + width * 0.31, top + 0.36, -1.32)
      group.add(crystal)
      this.addCracks(group, x, top, width, '#aaa396')
      if (anchor) {
        const seal = new THREE.Mesh(new THREE.TorusGeometry(0.72, 0.045, 6, 28), glowMat('#4ce2c2', 1.45))
        seal.rotation.x = Math.PI / 2
        seal.position.set(x - width * 0.28, top + 0.11, 1.23)
        group.add(seal)
      }
    }

    // A small mirrored undercroft at the gravity-shift ceiling keeps G playable both ways.
    const underside = new THREE.Mesh(boxGeo, flatMat(futureStyle ? '#1c263d' : '#244039', 0.64, 0.2))
    underside.scale.set(width * 0.78, 0.24, DEPTH * 0.74)
    underside.position.set(x, FLIP_Y - top + 0.22, 0)
    group.add(underside)
    const underGlow = new THREE.Mesh(boxGeo, glowMat(futureStyle ? '#934cff' : '#2bcca8', 0.6))
    underGlow.scale.set(width * 0.76, 0.045, 0.08)
    underGlow.position.set(x, FLIP_Y - top + 0.3, 2.0)
    group.add(underGlow)
  }

  private addAnchorGate(group: THREE.Group, x: number, top: number, realm: Dimension, index: number): void {
    const tint = realm === 0 ? '#9c55ff' : '#4ae9c9'
    const ring = new THREE.Mesh(new THREE.TorusGeometry(1.38, 0.08, 10, 44), glowMat(tint, 1.4))
    ring.position.set(x, top + 2.0, -0.3)
    ring.rotation.y = Math.PI / 2
    group.add(ring)
    const archMaterial = flatMat(realm === 0 ? '#263343' : '#45534e', realm === 0 ? 0.38 : 0.9, realm === 0 ? 0.72 : 0.05)
    for (const side of [-1, 1]) {
      const post = new THREE.Mesh(new THREE.CylinderGeometry(0.12, 0.18, 3.7, 8), archMaterial)
      post.position.set(x + side * 1.43, top + 1.83, -0.3)
      group.add(post)
      const rune = new THREE.Mesh(new THREE.OctahedronGeometry(0.13, 0), glowMat(tint, 1.6))
      rune.position.set(x + side * 1.44, top + 3.45, -0.25)
      group.add(rune)
    }
    const cap = new THREE.Mesh(boxGeo, archMaterial)
    cap.scale.set(3.2, 0.18, 0.42)
    cap.position.set(x, top + 3.68, -0.3)
    group.add(cap)
    if (index % 2 === 0) {
      const inscription = new THREE.Mesh(new THREE.TorusGeometry(0.34, 0.035, 6, 22), glowMat(realm === 0 ? '#e39dff' : '#77ffe1', 1.4))
      inscription.position.set(x, top + 2.0, -0.23)
      group.add(inscription)
    }
  }

  private addCircuitBeacon(group: THREE.Group, x: number, top: number): void {
    const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.09, 0.17, 1.8, 8), flatMat('#283241', 0.42, 0.68))
    pole.position.set(x, top + 0.88, -1.65)
    group.add(pole)
    const orb = new THREE.Mesh(sphereGeo, glowMat('#ff4e9d', 2.6))
    orb.scale.setScalar(0.22)
    orb.position.set(x, top + 1.86, -1.65)
    group.add(orb)
    const light = new THREE.PointLight('#fa51c4', 1.1, 5)
    light.position.copy(orb.position)
    group.add(light)
    this.flashLights.push(light)
  }

  private addRuneSeal(group: THREE.Group, x: number, top: number): void {
    const seal = new THREE.Mesh(new THREE.TorusGeometry(0.78, 0.045, 8, 40), glowMat('#5cf3d3', 1.9))
    seal.position.set(x, top + 0.44, -1.6)
    group.add(seal)
    const crystal = new THREE.Mesh(new THREE.OctahedronGeometry(0.28, 0), glowMat('#b46aff', 2.4))
    crystal.scale.y = 2.0
    crystal.position.set(x, top + 1.45, -1.6)
    group.add(crystal)
    const light = new THREE.PointLight('#32ddb8', 1.2, 5)
    light.position.copy(crystal.position)
    group.add(light)
    this.flashLights.push(light)
  }

  private addCracks(group: THREE.Group, x: number, top: number, width: number, color: string): void {
    const material = new THREE.LineBasicMaterial({ color, transparent: true, opacity: 0.62 })
    const segments = Math.max(1, Math.floor(width / 3.2))
    for (let i = 0; i < segments; i += 1) {
      const startX = x - width * 0.34 + i * (width * 0.42)
      const z = (i % 2 ? 1 : -1) * (0.38 + (i % 3) * 0.28)
      const points = [
        new THREE.Vector3(startX, top + 0.03, z),
        new THREE.Vector3(startX + 0.22, top + 0.035, z + 0.12),
        new THREE.Vector3(startX + 0.35, top + 0.035, z + 0.34),
        new THREE.Vector3(startX + 0.56, top + 0.035, z + 0.36),
      ]
      const line = new THREE.Line(new THREE.BufferGeometry().setFromPoints(points), material)
      group.add(line)
    }
  }

  private buildFuture(): void {
    this.addNebula(this.future, '#733dff', '#1f4acb')
    this.addPlanet(this.future, 78, 23, -65, '#28284e', '#9e55ff')
    this.addDistantIslands(this.future, 0)
    this.addCity(this.future)
    this.addFutureMachinery(this.future)
    this.addSatellite(this.future, 60, 31, -59)
    this.addSatellite(this.future, 28, 25, -48)
    this.addIndustrialSmoke(this.future)
    this.addSteamVents(this.future)
    this.addRobotWrecks(this.future)
    this.addSparks(this.future)
    this.addElectricArcs(this.future)
    this.addMeteors(this.future)
  }

  private buildFantasy(): void {
    this.addNebula(this.fantasy, '#0e907c', '#5e3aad')
    this.addPlanet(this.fantasy, 80, 22, -68, '#d9d8ff', '#8ddfff', true)
    this.addDistantIslands(this.fantasy, 1)
    this.addFantasySkyline(this.fantasy)
    this.addFireflies(this.fantasy)
    this.addClouds(this.fantasy)
    this.addAurora(this.fantasy)
    this.addTwistedRootTrees(this.fantasy)
    this.addWingedSilhouettes(this.fantasy)
  }

  private addStarfield(): void {
    const random = rng(2153)
    const positions: number[] = []
    const colors: number[] = []
    for (let i = 0; i < 460; i += 1) {
      positions.push(-45 + random() * 165, 3 + random() * 47, -50 - random() * 54)
      const tint = new THREE.Color(i % 9 === 0 ? '#9d7bff' : i % 7 === 0 ? '#80eeff' : '#d9dfff')
      colors.push(tint.r, tint.g, tint.b)
    }
    const geometry = new THREE.BufferGeometry()
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3))
    geometry.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3))
    const stars = new THREE.Points(geometry, new THREE.PointsMaterial({ size: 0.19, vertexColors: true, transparent: true, opacity: 0.8, sizeAttenuation: true }))
    this.scene.add(stars)
    this.atmosphere.push(stars)
  }

  private addNebula(group: THREE.Group, first: string, second: string): void {
    const texture = nebulaTexture(first, second)
    for (let i = 0; i < 3; i += 1) {
      const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: texture, color: '#ffffff', transparent: true, opacity: 0.24, depthWrite: false, blending: THREE.AdditiveBlending }))
      sprite.position.set(16 + i * 34, 18 + (i % 2) * 7, -72 - i * 7)
      sprite.scale.set(55 + i * 8, 23 + i * 4, 1)
      group.add(sprite)
    }
    const lowerVeil = new THREE.Sprite(new THREE.SpriteMaterial({ map: texture, color: '#ffffff', transparent: true, opacity: 0.26, depthWrite: false, blending: THREE.AdditiveBlending }))
    lowerVeil.position.set(40, -4.8, -48)
    lowerVeil.scale.set(128, 42, 1)
    group.add(lowerVeil)
  }

  private addPlanet(group: THREE.Group, x: number, y: number, z: number, color: string, halo: string, moon = false): void {
    const planet = new THREE.Mesh(new THREE.SphereGeometry(moon ? 8.8 : 7.2, 40, 30), flatMat(color, moon ? 0.88 : 0.45, moon ? 0.08 : 0.56))
    planet.position.set(x, y, z)
    group.add(planet)
    const atmo = new THREE.Mesh(new THREE.SphereGeometry(moon ? 9.15 : 7.55, 36, 24), new THREE.MeshBasicMaterial({ color: halo, transparent: true, opacity: 0.16, side: THREE.BackSide, blending: THREE.AdditiveBlending, depthWrite: false }))
    atmo.position.copy(planet.position)
    group.add(atmo)
    const ring = new THREE.Mesh(new THREE.TorusGeometry(moon ? 10 : 8.1, 0.065, 8, 80), new THREE.MeshBasicMaterial({ color: moon ? '#9cbbff' : '#ac72ff', transparent: true, opacity: 0.44 }))
    ring.position.copy(planet.position)
    ring.rotation.set(0.72, 0.2, 0.24)
    group.add(ring)
    if (!moon) {
      const scar = new THREE.Mesh(new THREE.TorusGeometry(2.1, 0.08, 5, 36), glowMat('#cf4efc', 0.8))
      scar.position.set(x + 1.1, y - 2.5, z + 6.3)
      scar.rotation.set(0.9, 0.3, 0.2)
      group.add(scar)
    }
  }

  private addCity(group: THREE.Group): void {
    const random = rng(8201)
    const wallMaterials = ['#1b2a3e', '#223149', '#2b2742', '#1c2c41'].map(c => flatMat(c, 0.62, 0.44))
    const windowMats = [glowMat('#8249ff', 0.7), glowMat('#4bdff5', 0.7), glowMat('#ec498f', 0.55)]
    for (let i = 0; i < 30; i += 1) {
      const x = -28 + i * 5 + random() * 3
      const width = 2 + random() * 3.6
      const height = 5 + random() * 14
      const depth = 2.4 + random() * 3
      const z = -20 - random() * 16
      const building = new THREE.Mesh(boxGeo, wallMaterials[i % wallMaterials.length])
      building.scale.set(width, height, depth)
      building.position.set(x, -3.8 + height / 2, z)
      building.castShadow = true
      group.add(building)
      const cap = new THREE.Mesh(boxGeo, flatMat(i % 3 === 0 ? '#46415f' : '#2b3a50', 0.44, 0.62))
      cap.scale.set(width + 0.28, 0.22, depth + 0.2)
      cap.position.set(x, -3.8 + height, z)
      group.add(cap)
      if (i % 4 === 0) {
        const mast = new THREE.Mesh(new THREE.CylinderGeometry(0.035, 0.055, height * 0.24, 6), flatMat('#49536b', 0.44, 0.55))
        mast.position.set(x - width * 0.23, cap.position.y + height * 0.12, z)
        group.add(mast)
        const beacon = new THREE.Mesh(sphereGeo, glowMat(i % 2 ? '#48e6ff' : '#ff4caa', 2))
        beacon.scale.setScalar(0.1)
        beacon.position.set(mast.position.x, mast.position.y + height * 0.12, z)
        group.add(beacon)
      }
      const floors = Math.floor(height / 1.8)
      const columns = Math.max(1, Math.floor(width / 1.0))
      for (let floor = 0; floor < floors; floor += 1) {
        for (let col = 0; col < columns; col += 1) {
          if (random() < 0.52) continue
          const windowMesh = new THREE.Mesh(boxGeo, windowMats[Math.floor(random() * windowMats.length)])
          windowMesh.scale.set(0.16 + random() * 0.16, 0.32, 0.06)
          windowMesh.position.set(x - width / 2 + ((col + 0.5) / columns) * width, -3.35 + floor * 1.55, z + depth / 2 + 0.04)
          group.add(windowMesh)
        }
      }
    }
    // Broken elevated highway and suspended chain of bright cable lights.
    for (let i = 0; i < 7; i += 1) {
      const slab = new THREE.Mesh(boxGeo, flatMat('#263144', 0.36, 0.82))
      slab.scale.set(8 - (i % 2) * 1.2, 0.48, 2.6)
      slab.position.set(-13 + i * 17, 8.4 + Math.sin(i * 1.7) * 1.5, -12)
      slab.rotation.z = (i % 2 ? -1 : 1) * 0.06
      group.add(slab)
      const wire = new THREE.Mesh(new THREE.CylinderGeometry(0.045, 0.045, 15.5, 6), glowMat(i % 2 ? '#713cef' : '#3cdeea', 0.55))
      wire.rotation.z = Math.PI / 2
      wire.position.set(slab.position.x + 6, slab.position.y - 1.5, -11)
      group.add(wire)
    }
    // Corrupted holograms and smoky exhaust are part of the distant set dressing.
    for (let i = 0; i < 7; i += 1) {
      const holo = new THREE.Mesh(boxGeo, new THREE.MeshBasicMaterial({ color: i % 2 ? '#d64dff' : '#42eaff', transparent: true, opacity: 0.14, wireframe: true, depthWrite: false }))
      holo.scale.set(1.5, 2.7 + random() * 2.1, 0.05)
      holo.position.set(i * 19 - 9, 2 + random() * 6, -9)
      holo.userData.flicker = i
      group.add(holo)
    }
  }

  private addFutureMachinery(group: THREE.Group): void {
    const random = rng(991)
    for (let i = 0; i < 20; i += 1) {
      const x = -10 + i * 5.8
      const y = 4.8 + random() * 5
      const machine = new THREE.Group()
      const shell = new THREE.Mesh(boxGeo, flatMat('#151e2e', 0.32, 0.82))
      shell.scale.set(1.1, 0.9, 1.1)
      machine.add(shell)
      const pipe = new THREE.Mesh(new THREE.CylinderGeometry(0.08, 0.1, 1.4, 8), flatMat('#657084', 0.36, 0.74))
      pipe.position.set(0.43, 0.72, 0)
      machine.add(pipe)
      const lens = new THREE.Mesh(sphereGeo, glowMat(i % 3 ? '#44e5ff' : '#ff4e9e', 1.25))
      lens.scale.set(0.2, 0.2, 0.1)
      lens.position.set(0, 0.06, 0.56)
      machine.add(lens)
      machine.position.set(x, y, -4.8)
      group.add(machine)
    }
  }

  private addSatellite(group: THREE.Group, x: number, y: number, z: number): void {
    const satellite = new THREE.Group()
    const core = new THREE.Mesh(new THREE.CylinderGeometry(0.34, 0.34, 0.72, 10), flatMat('#66758d', 0.45, 0.62))
    core.rotation.z = Math.PI / 2
    satellite.add(core)
    for (const side of [-1, 1]) {
      const panel = new THREE.Mesh(boxGeo, flatMat('#203451', 0.32, 0.76))
      panel.scale.set(1.65, 0.1, 0.9)
      panel.position.set(side * 1.3, 0, 0)
      satellite.add(panel)
      for (let strip = -2; strip <= 2; strip += 1) {
        const line = new THREE.Mesh(boxGeo, glowMat('#398dc5', 0.42))
        line.scale.set(0.04, 0.12, 0.82)
        line.position.set(side * 1.3 + strip * 0.27, 0.03, 0)
        satellite.add(line)
      }
    }
    const dish = new THREE.Mesh(new THREE.SphereGeometry(0.48, 10, 6, 0, Math.PI * 2, 0, Math.PI * 0.5), flatMat('#a2a8bf', 0.42, 0.58))
    dish.position.y = 0.54
    satellite.add(dish)
    satellite.position.set(x, y, z)
    satellite.rotation.set(0.25, 0.1, -0.2)
    group.add(satellite)
    this.satellites.push(satellite)
  }

  private addIndustrialSmoke(group: THREE.Group): void {
    const texture = nebulaTexture('#7e84a9', '#c8a8ff')
    for (let i = 0; i < 7; i += 1) {
      const material = new THREE.SpriteMaterial({ map: texture, color: '#9aa5be', transparent: true, opacity: 0.14, depthWrite: false })
      const sprite = new THREE.Sprite(material)
      const x = -22 + i * 19
      const y = 4 + (i % 3) * 2.3
      sprite.position.set(x, y, -17 - (i % 2) * 5)
      sprite.scale.set(11 + (i % 3) * 3, 5 + (i % 2) * 2, 1)
      group.add(sprite)
      this.driftingSprites.push({ sprite, x, y, amplitude: 2.4, speed: 0.11 + i * 0.006, phase: i * 1.7, opacity: 0.14 })
    }
  }

  private addSteamVents(group: THREE.Group): void {
    const texture = nebulaTexture('#d8d7ee', '#8194b5')
    for (const segment of [0, 2, 4]) {
      const piece = routeLayout().find(item => item.segment === segment && item.step === 3)!
      const x = piece.centerX
      const top = piece.top
      const pipe = new THREE.Mesh(new THREE.CylinderGeometry(0.2, 0.28, 0.65, 9), flatMat('#394659', 0.52, 0.68))
      pipe.position.set(x, top + 0.28, 2.15)
      group.add(pipe)
      const rim = new THREE.Mesh(new THREE.TorusGeometry(0.24, 0.05, 6, 14), glowMat('#5bdff1', 0.72))
      rim.rotation.x = Math.PI / 2
      rim.position.set(x, top + 0.61, 2.15)
      group.add(rim)
      for (let puff = 0; puff < 2; puff += 1) {
        const material = new THREE.SpriteMaterial({ map: texture, color: '#bdcce7', transparent: true, opacity: 0.21, depthWrite: false })
        const sprite = new THREE.Sprite(material)
        const y = top + 1.15 + puff * 0.7
        sprite.position.set(x, y, 2.12)
        sprite.scale.set(1.45 + puff * 0.35, 2.0 + puff * 0.4, 1)
        group.add(sprite)
        this.driftingSprites.push({ sprite, x, y, amplitude: 0.32, speed: 0.8 + puff * 0.13, phase: segment + puff, opacity: 0.2 })
      }
    }
  }

  private addRobotWrecks(group: THREE.Group): void {
    for (const index of [1, 3, 5]) {
      const wreck = new THREE.Group()
      const shell = flatMat('#273245', 0.58, 0.68)
      const torso = new THREE.Mesh(boxGeo, shell)
      torso.scale.set(0.82, 0.64, 0.42)
      wreck.add(torso)
      const head = new THREE.Mesh(new THREE.BoxGeometry(0.46, 0.4, 0.38), flatMat('#47546a', 0.48, 0.65))
      head.position.set(0.08, 0.54, 0)
      wreck.add(head)
      const eye = new THREE.Mesh(sphereGeo, glowMat('#ff4c9a', 1.6))
      eye.scale.set(0.12, 0.1, 0.06)
      eye.position.set(0.09, 0.56, 0.22)
      wreck.add(eye)
      for (const side of [-1, 1]) {
        const arm = new THREE.Mesh(new THREE.CylinderGeometry(0.09, 0.13, 0.72, 7), shell)
        arm.position.set(side * 0.55, -0.3, 0)
        arm.rotation.z = side * (0.82 + (index % 2) * 0.25)
        wreck.add(arm)
      }
      const cable = new THREE.Mesh(new THREE.CylinderGeometry(0.025, 0.025, 0.72, 5), glowMat('#b554ff', 0.9))
      cable.position.set(0.42, -0.1, 0.12)
      cable.rotation.z = -0.9
      wreck.add(cable)
      wreck.position.set(ANCHORS[index], ANCHOR_TOPS[index] + 0.55, -2.0)
      wreck.rotation.z = index % 2 ? -0.36 : 0.28
      group.add(wreck)
    }
  }

  private addSparks(group: THREE.Group): void {
    const random = rng(3377)
    const positions: number[] = []
    for (let i = 0; i < 150; i += 1) positions.push(-8 + random() * 103, -1.2 + random() * 3.8, 1.4 + random() * 1.3)
    const geometry = new THREE.BufferGeometry()
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3))
    const sparks = new THREE.Points(geometry, new THREE.PointsMaterial({ color: '#ffad70', size: 0.12, transparent: true, opacity: 0.72, blending: THREE.AdditiveBlending, depthWrite: false }))
    group.add(sparks)
    this.atmosphere.push(sparks)
  }

  private addElectricArcs(group: THREE.Group): void {
    for (let i = 0; i < 9; i += 1) {
      const x = -2 + i * 11
      const z = i % 2 ? 1.85 : -1.9
      const points = [
        new THREE.Vector3(x, -0.7, z),
        new THREE.Vector3(x + 0.14, -0.28, z + 0.08),
        new THREE.Vector3(x - 0.06, 0.06, z + 0.1),
        new THREE.Vector3(x + 0.22, 0.43, z),
      ]
      const line = new THREE.Line(new THREE.BufferGeometry().setFromPoints(points), new THREE.LineBasicMaterial({ color: i % 2 ? '#72edff' : '#db68ff', transparent: true, opacity: 0.08, blending: THREE.AdditiveBlending, depthWrite: false }))
      line.userData.phase = i * 1.73
      group.add(line)
      this.electricArcs.push(line)
    }
  }

  private addMeteors(group: THREE.Group): void {
    for (let i = 0; i < 4; i += 1) {
      const meteor = new THREE.Group()
      const stone = new THREE.Mesh(new THREE.IcosahedronGeometry(0.25 + (i % 2) * 0.12, 0), flatMat('#aca1cf', 0.8, 0.1))
      meteor.add(stone)
      const tail = new THREE.Mesh(boxGeo, new THREE.MeshBasicMaterial({ color: '#bd71ff', transparent: true, opacity: 0.44, blending: THREE.AdditiveBlending }))
      tail.scale.set(2.8, 0.06, 0.04)
      tail.position.x = -1.45
      meteor.add(tail)
      meteor.position.set(-26 + i * 36, 24 + i % 3 * 4, -31)
      meteor.rotation.z = -0.24
    meteor.userData.originX = meteor.position.x
    meteor.userData.originY = meteor.position.y
    meteor.userData.phase = i * 4.7
    group.add(meteor)
    this.meteors.push(meteor)
  }
  }

  private addDistantIslands(group: THREE.Group, realm: Dimension): void {
    const random = rng(700 + realm)
    for (let i = 0; i < 11; i += 1) {
      const x = -14 + i * 13.6 + random() * 4
      const y = -7 + random() * 15
      const z = -29 - random() * 15
      const r = 1.7 + random() * 2.8
      const island = new THREE.Group()
      const top = new THREE.Mesh(new THREE.CylinderGeometry(r, r * 0.82, 0.55, 10), flatMat(realm === 0 ? '#22233b' : '#2b4a43', realm === 0 ? 0.58 : 0.92, 0.12))
      top.position.y = 0.14
      island.add(top)
      const rock = new THREE.Mesh(new THREE.ConeGeometry(r * 0.8, r * 1.8, 8, 2), flatMat(realm === 0 ? '#111523' : '#16302a', 0.96, 0.05))
      rock.rotation.x = Math.PI
      rock.position.y = -0.9
      island.add(rock)
      if (realm === 0) {
        for (let c = 0; c < 3; c += 1) {
          const shard = new THREE.Mesh(new THREE.OctahedronGeometry(0.23 + random() * 0.2, 0), glowMat(c % 2 ? '#52dff5' : '#9549ff', 1.4))
          shard.scale.y = 2.1
          shard.position.set((c - 1) * 0.8, 0.65, 0)
          island.add(shard)
        }
      } else {
        const tree = new THREE.Mesh(new THREE.ConeGeometry(0.55, 2.2, 7), flatMat('#2f6750', 0.94, 0.02))
        tree.position.y = 1.1
        island.add(tree)
      }
      island.position.set(x, y, z)
      island.rotation.z = (random() - 0.5) * 0.3
      group.add(island)
    }
  }

  private addFantasySkyline(group: THREE.Group): void {
    const random = rng(479)
    const stone = flatMat('#263941', 0.92, 0.08)
    const highlight = flatMat('#3d5652', 0.9, 0.1)
    for (let i = 0; i < 18; i += 1) {
      const x = -22 + i * 8.3
      const h = 6 + random() * 13
      const width = 1.5 + random() * 2.1
      const z = -22 - random() * 12
      const tower = new THREE.Group()
      const shaft = new THREE.Mesh(new THREE.CylinderGeometry(width * 0.27, width * 0.42, h, 8), stone)
      shaft.position.y = h / 2 - 3.2
      tower.add(shaft)
      const cap = new THREE.Mesh(new THREE.ConeGeometry(width * 0.5, 2.4 + random() * 2, 8), highlight)
      cap.position.y = h + 0.2 - 3.2
      tower.add(cap)
      const windowGlow = new THREE.Mesh(boxGeo, glowMat(i % 3 ? '#4ccfb1' : '#ae73ee', 0.65))
      windowGlow.scale.set(0.18, 0.9, 0.04)
      windowGlow.position.set(0, 0.2, width * 0.36)
      tower.add(windowGlow)
      if (i % 3 === 0) {
        const root = new THREE.Mesh(new THREE.TorusGeometry(1.2, 0.07, 6, 28), glowMat('#31c9a7', 0.7))
        root.position.set(-1.2, 1, 0.2)
        root.rotation.y = Math.PI / 2
        tower.add(root)
      }
      tower.position.set(x, 0, z)
      group.add(tower)
    }
    // Broken stone arches and moonlit waterfall columns.
    for (let i = 0; i < 5; i += 1) {
      const x = -5 + i * 26
      const arch = new THREE.Mesh(new THREE.TorusGeometry(3.3, 0.24, 8, 36, Math.PI * 1.18), stone)
      arch.position.set(x, 8 + (i % 2) * 3, -16)
      arch.rotation.z = i % 2 ? Math.PI * 0.18 : 0
      group.add(arch)
      const waterfall = new THREE.Mesh(boxGeo, new THREE.MeshBasicMaterial({ color: '#67cafa', transparent: true, opacity: 0.17, blending: THREE.AdditiveBlending, depthWrite: false }))
      waterfall.scale.set(0.85, 10 + (i % 3) * 2, 0.12)
      waterfall.position.set(x + 7, 0, -27)
      group.add(waterfall)
    }
    for (let i = 0; i < 8; i += 1) {
      const statue = new THREE.Mesh(new THREE.CapsuleGeometry(0.65, 3.4, 4, 8), stone)
      statue.position.set(4 + i * 14, 2, -13)
      statue.scale.set(1.1, 1.1, 0.5)
      group.add(statue)
      const halo = new THREE.Mesh(new THREE.TorusGeometry(1, 0.045, 6, 28), glowMat('#56e7c1', 0.72))
      halo.position.set(statue.position.x, 4, -12.6)
      group.add(halo)
    }
  }

  private buildHazards(): void {
    for (let segment = 0; segment < SEGMENT_REALMS.length; segment += 1) {
      const realm = SEGMENT_REALMS[segment]
      const x = ANCHORS[segment] + 9
      const k = 3 / 6
      const top = THREE.MathUtils.lerp(ANCHOR_TOPS[segment], ANCHOR_TOPS[segment + 1], k) + Math.sin(k * Math.PI) * (segment % 2 ? -0.22 : 0.22)
      const group = new THREE.Group()
      const coreColor = realm === 0 ? '#ff4a9b' : '#bd71ff'
      const core = new THREE.Mesh(sphereGeo, glowMat(coreColor, 2.2))
      core.scale.setScalar(0.42)
      group.add(core)
      const ring = new THREE.Mesh(new THREE.TorusGeometry(0.62, 0.055, 8, 28), glowMat(realm === 0 ? '#48e5ff' : '#4af0c5', 1.3))
      ring.rotation.x = Math.PI / 2
      group.add(ring)
      for (let wing = -1; wing <= 1; wing += 2) {
        const blade = new THREE.Mesh(new THREE.TetrahedronGeometry(0.4, 0), flatMat(realm === 0 ? '#30394a' : '#31473c', 0.55, 0.28))
        blade.scale.set(1.1, 0.55, 0.6)
        blade.position.set(wing * 0.55, 0, 0)
        group.add(blade)
      }
      group.position.set(x, top + 1.4, 0.3)
      ;(realm === 0 ? this.future : this.fantasy).add(group)
      this.hazards.push({ mesh: group, realm, x, y: top + 1.4, phase: segment * 1.8, speed: 1.2, sway: 0.9, radius: 0.78 })
      const light = new THREE.PointLight(coreColor, 0.75, 4)
      group.add(light)
    }
  }

  private addFireflies(group: THREE.Group): void {
    const random = rng(512)
    const positions: number[] = []
    for (let i = 0; i < 140; i += 1) positions.push(-18 + random() * 128, -1 + random() * 16, -3 - random() * 11)
    const geometry = new THREE.BufferGeometry()
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3))
    const points = new THREE.Points(geometry, new THREE.PointsMaterial({ color: '#6affd4', size: 0.19, transparent: true, opacity: 0.75, blending: THREE.AdditiveBlending, depthWrite: false }))
    group.add(points)
    this.atmosphere.push(points)
  }

  private addClouds(group: THREE.Group): void {
    const texture = nebulaTexture('#7bd8df', '#9e79db')
    for (let i = 0; i < 8; i += 1) {
      const material = new THREE.SpriteMaterial({ map: texture, color: '#a8caff', transparent: true, opacity: 0.17, depthWrite: false })
      const cloud = new THREE.Sprite(material)
      const x = -13 + i * 15
      const y = 13 + (i % 3) * 2.3
      cloud.position.set(x, y, -31 - (i % 2) * 6)
      cloud.scale.set(17 + (i % 3) * 3, 5.5 + (i % 2), 1)
      group.add(cloud)
      this.driftingSprites.push({ sprite: cloud, x, y, amplitude: 3.2, speed: 0.035 + i * 0.003, phase: i * 2.1, opacity: 0.17 })
    }
  }

  private addAurora(group: THREE.Group): void {
    const material = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
      uniforms: { uTime: { value: 0 } },
      vertexShader: `varying vec2 vUv; void main(){ vUv=uv; gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.0); }`,
      fragmentShader: `
        varying vec2 vUv; uniform float uTime;
        void main(){
          float wave=0.5+0.5*sin(vUv.x*13.0+uTime*0.17+sin(vUv.x*4.0)*1.9);
          float band=smoothstep(0.34,0.56,wave)*(1.0-smoothstep(0.68,0.9,wave));
          float edge=smoothstep(0.0,0.23,vUv.y)*(1.0-smoothstep(0.78,1.0,vUv.y));
          vec3 color=mix(vec3(0.12,0.67,0.53),vec3(0.47,0.29,0.82),vUv.x);
          gl_FragColor=vec4(color,band*edge*0.16);
        }`,
    })
    const ribbon = new THREE.Mesh(new THREE.PlaneGeometry(118, 24), material)
    ribbon.position.set(43, 27, -48)
    ribbon.rotation.z = -0.035
    group.add(ribbon)
    this.auroras.push(material)
  }

  private addTwistedRootTrees(group: THREE.Group): void {
    for (const index of [0, 2, 4]) {
      const tree = new THREE.Group()
      const bark = flatMat('#1b302f', 0.96, 0.02)
      const glow = glowMat('#2dc6a2', 0.42)
      const trunk = new THREE.CatmullRomCurve3([
        new THREE.Vector3(0, 0, 0), new THREE.Vector3(0.26, 1.0, 0), new THREE.Vector3(-0.16, 2.2, 0.06),
        new THREE.Vector3(0.42, 3.5, 0), new THREE.Vector3(0.05, 4.8, -0.06), new THREE.Vector3(0.6, 5.8, 0),
      ])
      tree.add(new THREE.Mesh(new THREE.TubeGeometry(trunk, 24, 0.22, 7, false), bark))
      for (const side of [-1, 1]) {
        const branch = new THREE.CatmullRomCurve3([
          new THREE.Vector3(0.12, 2.4, 0), new THREE.Vector3(side * 0.62, 3.0, 0.02),
          new THREE.Vector3(side * 1.16, 4.1, 0), new THREE.Vector3(side * 1.85, 4.55, -0.02),
        ])
        tree.add(new THREE.Mesh(new THREE.TubeGeometry(branch, 16, 0.105, 6, false), bark))
        const root = new THREE.CatmullRomCurve3([
          new THREE.Vector3(0, 0.16, 0.08), new THREE.Vector3(side * 0.52, 0.08, 0.12), new THREE.Vector3(side * 1.25, 0.03, 0.2),
        ])
        tree.add(new THREE.Mesh(new THREE.TubeGeometry(root, 12, 0.045, 5, false), glow))
      }
      for (let shard = 0; shard < 3; shard += 1) {
        const crystal = new THREE.Mesh(new THREE.OctahedronGeometry(0.22 + shard * 0.045, 0), glowMat(shard % 2 ? '#65f2ce' : '#ad79ff', 0.9))
        crystal.scale.y = 1.8
        crystal.position.set((shard - 1) * 0.58, 5.25 + (shard % 2) * 0.35, 0)
        tree.add(crystal)
      }
      tree.position.set(ANCHORS[index] + 1.2, ANCHOR_TOPS[index], -6.2)
      group.add(tree)
    }
  }

  private addWingedSilhouettes(group: THREE.Group): void {
    const shape = new THREE.Shape()
    shape.moveTo(0, 0)
    shape.quadraticCurveTo(-0.75, 1.05, -1.8, 0.85)
    shape.quadraticCurveTo(-1.45, 0.18, -0.98, -0.17)
    shape.quadraticCurveTo(-0.43, -0.42, 0, 0)
    const wingGeometry = new THREE.ShapeGeometry(shape)
    const silhouette = new THREE.MeshBasicMaterial({ color: '#071117', transparent: true, opacity: 0.78, side: THREE.DoubleSide, depthWrite: false })
    for (let i = 0; i < 6; i += 1) {
      const flyer = new THREE.Group()
      const left = new THREE.Mesh(wingGeometry, silhouette)
      const right = left.clone()
      right.scale.x = -1
      right.rotation.y = Math.PI
      flyer.add(left, right)
      const body = new THREE.Mesh(new THREE.CapsuleGeometry(0.14, 0.48, 2, 7), silhouette)
      body.position.y = -0.18
      flyer.add(body)
      const head = new THREE.Mesh(new THREE.SphereGeometry(0.16, 8, 6), silhouette)
      head.position.y = 0.32
      flyer.add(head)
      const x = -10 + i * 18
      const y = 17 + (i % 3) * 3.2
      flyer.position.set(x, y, -18)
      group.add(flyer)
      this.winged.push({ group: flyer, x, y, speed: 0.11 + i * 0.009, phase: i * 1.8 })
    }
  }

}

function nebulaTexture(first: string, second: string): THREE.CanvasTexture {
  const canvas = document.createElement('canvas')
  canvas.width = 512
  canvas.height = 256
  const ctx = canvas.getContext('2d')!
  const base = ctx.createLinearGradient(0, 0, 512, 256)
  base.addColorStop(0, 'rgba(0,0,0,0)')
  base.addColorStop(0.38, `${first}24`)
  base.addColorStop(0.62, `${second}38`)
  base.addColorStop(1, 'rgba(0,0,0,0)')
  ctx.fillStyle = base
  ctx.fillRect(0, 0, 512, 256)
  for (let i = 0; i < 32; i += 1) {
    const x = (i * 117 + 33) % 512
    const y = (i * 71 + 19) % 256
    const radius = 20 + (i * 19) % 70
    const gradient = ctx.createRadialGradient(x, y, 2, x, y, radius)
    gradient.addColorStop(0, i % 2 ? `${first}44` : `${second}44`)
    gradient.addColorStop(1, 'rgba(0,0,0,0)')
    ctx.fillStyle = gradient
    ctx.fillRect(x - radius, y - radius, radius * 2, radius * 2)
  }
  const texture = new THREE.CanvasTexture(canvas)
  texture.colorSpace = THREE.SRGBColorSpace
  return texture
}

export function rng(seed: number): () => number {
  let value = seed >>> 0
  return () => {
    value = (value + 0x6d2b79f5) >>> 0
    let n = value
    n = Math.imul(n ^ (n >>> 15), n | 1)
    n ^= n + Math.imul(n ^ (n >>> 7), n | 61)
    return ((n ^ (n >>> 14)) >>> 0) / 4294967296
  }
}
