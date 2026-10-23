import * as THREE from 'three'
import type { Audio } from '../engine/audio'
import type { Input } from '../engine/input'
import { Physics, RAPIER } from '../engine/physics'
import type { Renderer } from '../engine/renderer'
import type { Quality } from '../engine/save'
import { FollowCamera } from './camera'
import { Collectibles } from './collectibles'
import { CONFIG } from './config'
import { tuning } from './tuning'
import { Effects } from './fx'
import { Player, type PlayerEvent } from './player'
import { collect, createRun, damage, tick, type RunState } from './rules'
import { World, type Dimension } from './world'

export type Mode = 'attract' | 'playing' | 'paused' | 'ended'
export type Hint = 'move' | 'jump' | 'dimension' | 'cores'
export type Compass = { angle: number; distance: number; rise: number }

export type GameHooks = {
  popup(text: string, screen: { x: number; y: number }, kind: 'score' | 'hurt'): void
  hurt(): void
  hint(hint: Hint | null): void
  /** The first-run tutorial reached its last step. */
  tutorialDone(): void
  phaseChange(dimension: Dimension): void
  checkpoint(index: number): void
  gravityChange(sign: 1 | -1): void
  freezeChange(seconds: number): void
  end(run: RunState): void
}

/** One living side-on scene, with Rapier for contacts and pure rules retained from the starter. */
export class Game {
  mode: Mode = 'attract'
  run: RunState
  reducedMotion = false
  dimension: Dimension = 0
  freezeSeconds = 0
  freezeCooldown = 0
  private readonly physics: Physics
  private readonly world: World
  private readonly player: Player
  private readonly cam: FollowCamera
  private readonly cores: [Collectibles, Collectibles]
  private readonly fx = new Effects()
  private simTime = 0
  private time = 0
  private tutorial: Hint | null = null
  private tutorialStart = new THREE.Vector3()
  private checkpointIndex = 0
  private checkpointDimension: Dimension = 0
  private checkpointGravity: 1 | -1 = 1
  private readonly down = new RAPIER.Ray({ x: 0, y: -1, z: 0 }, { x: 0, y: -1, z: 0 })

  constructor(
    private readonly renderer: Renderer,
    private readonly input: Input,
    private readonly audio: Audio,
    private readonly hooks: GameHooks,
  ) {
    this.physics = new Physics(CONFIG.player.gravity)
    this.world = new World(this.physics, renderer.shadowMapSize)
    this.player = new Player(this.physics, this.world.spawn)
    this.cam = new FollowCamera(this.physics, this.player.collider)
    this.cores = [new Collectibles(this.world.coreSpotsByDimension[0]), new Collectibles(this.world.coreSpotsByDimension[1])]
    this.world.scene.add(this.player.root, this.player.shadowMesh, this.cores[0].group, this.cores[1].group, this.fx.mesh)
    this.syncDimensionContent()
    this.run = createRun(this.cores[0].total + this.cores[1].total)
    this.cam.reset(this.world.spawn, 0)
  }

  get camera(): THREE.PerspectiveCamera { return this.cam.camera }
  get playerPosition(): THREE.Vector3 { return this.player.position }
  get gravitySign(): 1 | -1 { return this.player.gravitySign }
  get nextDimension(): Dimension { return this.world.nextRequiredDimension(this.player.position.x) }

  /** Load the saved-version asset asynchronously; title/play remain responsive on any load failure. */
  async loadTraveler(url: string): Promise<void> {
    try {
      const { GLTFLoader } = await import('three/addons/loaders/GLTFLoader.js')
      const gltf = await new GLTFLoader().loadAsync(url)
      this.player.setTraveler(gltf.scene, gltf.animations)
    } catch (error) {
      console.warn('Traveler model unavailable; retaining the built-in suit.', error)
    }
  }

  start(tutorial: boolean): void {
    tuning.activate('run')
    this.dimension = 0
    this.world.setDimension(this.dimension, true)
    this.syncDimensionContent()
    this.player.setGravityDirection(1)
    this.physics.world.gravity = { x: 0, y: CONFIG.player.gravity, z: 0 }
    this.cores.forEach(core => core.reset())
    this.fx.clear()
    this.player.teleport(this.world.spawn)
    this.player.facing = 1
    this.cam.reset(this.world.spawn, 0)
    this.freezeSeconds = 0
    this.freezeCooldown = 0
    this.checkpointIndex = 0
    this.checkpointDimension = 0
    this.checkpointGravity = 1
    this.run = { ...createRun(this.cores[0].total + this.cores[1].total), unranked: tuning.unranked }
    this.mode = 'playing'
    this.input.endFrame()
    this.input.takeLook()
    this.tutorial = tutorial ? 'move' : null
    this.tutorialStart.copy(this.world.spawn)
    this.hooks.phaseChange(this.dimension)
    this.hooks.gravityChange(this.player.gravitySign)
    this.hooks.freezeChange(0)
    this.hooks.hint(this.tutorial)
  }

  pause(): void { if (this.mode === 'playing') this.mode = 'paused' }
  resume(): void {
    if (this.mode !== 'paused') return
    this.mode = 'playing'
    this.input.endFrame()
    this.input.takeLook()
  }
  toTitle(): void { this.mode = 'attract'; this.hooks.hint(null) }

  setQuality(quality: Quality): void {
    this.renderer.applyQuality(quality)
    const size = this.renderer.shadowMapSize
    const shadow = this.world.sun.shadow
    shadow.map?.dispose()
    shadow.map = null
    shadow.mapSize.set(size, size)
    this.world.scene.traverse(obj => {
      const material = (obj as THREE.Mesh).material
      for (const m of Array.isArray(material) ? material : material ? [material] : []) m.needsUpdate = true
    })
  }

  step(dt: number): void {
    this.simTime += dt
    const jumpPressed = this.input.consume('jump')
    const dashPressed = this.input.consume('dash')
    const dimensionPressed = this.input.consume('dimension')
    const gravityPressed = this.input.consume('gravity')
    const freezePressed = this.input.consume('freeze')
    const playing = this.mode === 'playing'

    if (playing && dimensionPressed) this.switchDimension()
    if (playing && gravityPressed) this.reverseGravity()
    if (playing && freezePressed && this.freezeCooldown <= 0) {
      this.freezeSeconds = this.freezeSeconds > 0 ? 0 : 3.6
      this.freezeCooldown = this.freezeSeconds > 0 ? 7.0 : 1.0
      this.hooks.freezeChange(this.freezeSeconds)
      this.fx.burst(this.player.position, this.dimension === 0 ? '#be52ff' : '#57f0ce', 26, 4.5)
    }

    this.freezeCooldown = Math.max(0, this.freezeCooldown - dt)
    if (this.freezeSeconds > 0) {
      this.freezeSeconds = Math.max(0, this.freezeSeconds - dt)
      if (this.freezeSeconds === 0) this.hooks.freezeChange(0)
    }
    this.world.stepMovers(this.simTime)
    this.world.stepHazards(dt, this.freezeSeconds > 0)

    const events: PlayerEvent[] = []
    if (playing) {
      this.player.step(dt, {
        moveX: this.input.move.x,
        moveY: 0,
        sprint: this.input.held('sprint'),
        jumpPressed,
        jumpHeld: this.input.held('jump'),
        dashPressed,
      }, this.cam.yaw, events)
    }
    this.physics.step(dt)
    if (!playing) return
    this.run.unranked ||= tuning.unranked

    const pos = this.player.position
    for (const event of events) this.onPlayerEvent(event, pos)
    for (const at of this.cores[this.dimension].collect(pos, CONFIG.player.radius + 0.62)) {
      const result = collect(this.run)
      this.run = result.state
      this.audio.play('pickup')
      this.fx.burst(at, this.dimension === 0 ? '#cb75ff' : '#57f0ce', 24, 6.2)
      const combo = this.run.combo > 1 ? `  ×${this.run.combo}` : ''
      this.hooks.popup(`+${result.points}${combo}`, this.project(at), 'score')
      if (this.tutorial === 'cores') {
        this.advanceTutorial(null)
        this.hooks.tutorialDone()
      }
    }

    if (this.freezeSeconds <= 0) {
      const hit = this.world.hazardPositions(this.dimension).find(point => {
        const dy = THREE.MathUtils.clamp(point.y, pos.y - CONFIG.player.halfHeight, pos.y + CONFIG.player.halfHeight)
        return Math.hypot(point.x - pos.x, point.y - dy, point.z - pos.z) < CONFIG.drones.radius + CONFIG.player.radius
      })
      if (hit) {
        const result = damage(this.run)
        if (result.hurt) {
          this.run = result.state
          this.player.knockback(hit)
          this.onHurt(pos)
        }
      }
    }

    this.updateCheckpoint(pos)
    const lostBelow = this.player.gravitySign > 0 && pos.y < CONFIG.run.killY
    const lostAbove = this.player.gravitySign < 0 && pos.y > this.world.gravityFlipY + 14
    if (lostBelow || lostAbove) this.respawnAfterFall(pos)

    this.run = tick(this.run, dt)
    this.updateTutorial(pos)
    if (this.run.phase !== 'playing') {
      this.mode = 'ended'
      this.hooks.hint(null)
      this.audio.play(this.run.phase === 'won' ? 'win' : 'lose')
      if (this.run.phase === 'won') this.fx.burst(pos.clone().setY(pos.y + 1), '#8af5ff', 56, 9)
      this.hooks.end(this.run)
    }
  }

  render(alpha: number, frameSeconds: number): void {
    this.time += frameSeconds
    this.physics.sync(alpha)
    const target = this.mode === 'attract'
      ? new THREE.Vector3(Math.sin(this.time * 0.16) * 2, 1.2 + Math.sin(this.time * 0.3) * 0.18, 0)
      : this.player.root.position
    if (this.mode === 'playing' && this.tutorial === 'move' && this.player.position.distanceTo(this.tutorialStart) > 2.5) this.advanceTutorial('jump')
    const look = this.input.takeLook()
    this.cam.update(target, look, frameSeconds, false, this.reducedMotion)
    this.player.animate(frameSeconds, this.time, this.run.invulnerable > 0 && this.mode === 'playing', this.groundBelow(target))
    this.cores.forEach(core => core.animate(frameSeconds))
    this.fx.update(frameSeconds)
    this.world.update(frameSeconds, target)
    this.renderer.render(this.world.scene, this.cam.camera)
  }

  /** Direction to the nearest still-visible shard relative to the side-scrolling view. */
  compass(): Compass | null {
    const pos = this.player.position
    const remaining = this.cores[this.dimension].remaining()
    const candidates = remaining.length ? remaining : this.cores[1 - this.dimension as Dimension].remaining()
    const best = candidates.reduce<THREE.Vector3 | undefined>((current, item) => !current || item.distanceToSquared(pos) < current.distanceToSquared(pos) ? item : current, undefined)
    if (!best) return null
    const delta = best.clone().sub(pos)
    return { angle: delta.x >= 0 ? 0 : Math.PI, distance: delta.length(), rise: delta.y }
  }

  project(world: THREE.Vector3): { x: number; y: number } {
    const v = world.clone().project(this.cam.camera)
    const canvas = this.renderer.canvas
    return { x: ((v.x + 1) / 2) * canvas.clientWidth, y: ((1 - v.y) / 2) * canvas.clientHeight }
  }

  private switchDimension(): void {
    const next = (1 - this.dimension) as Dimension
    const pos = this.player.position
    if (!this.world.isSafeAt(pos, next, this.player.gravitySign)) return
    this.dimension = next
    this.world.setDimension(next)
    this.syncDimensionContent()
    this.hooks.phaseChange(next)
    this.fx.burst(pos, next === 0 ? '#b04aff' : '#55f5d0', 44, 8)
    this.audio.play('dash')
    if (this.tutorial === 'dimension') this.advanceTutorial('cores')
  }

  private reverseGravity(): void {
    const next = (this.player.gravitySign * -1) as 1 | -1
    const pos = this.player.position
    // Only reverse when there is a real destination surface directly opposite this one.
    if (!this.world.isSafeAt(pos, this.dimension, next)) {
      const hasDeck = this.world.isSafeAt(pos, this.dimension, this.player.gravitySign)
      if (!hasDeck) return
    }
    this.player.setGravityDirection(next)
    this.physics.world.gravity = { x: 0, y: CONFIG.player.gravity * next, z: 0 }
    this.hooks.gravityChange(next)
    this.fx.burst(pos, next < 0 ? '#54f3d0' : '#ba63ff', 28, 5.4)
    this.audio.play('dash')
  }

  private updateCheckpoint(position: THREE.Vector3): void {
    if (!this.player.grounded) return
    const next = this.world.checkpointAtOrBefore(position.x)
    if (next <= this.checkpointIndex) return
    const anchor = this.world.checkpointAnchorIndex(next)
    const checkpoint = this.world.anchorPosition(anchor, this.dimension, this.player.gravitySign)
    if (Math.abs(position.x - checkpoint.x) > 4.2 || !this.world.isSafeAt(position, this.dimension, this.player.gravitySign)) return
    this.checkpointIndex = next
    this.checkpointDimension = this.dimension
    this.checkpointGravity = this.player.gravitySign
    this.player.safe.copy(checkpoint)
    this.hooks.checkpoint(next)
    this.fx.burst(new THREE.Vector3(checkpoint.x, checkpoint.y, 0), '#ffd078', 34, 6)
  }

  private respawnAfterFall(pos: THREE.Vector3): void {
    this.run = damage(this.run, true).state
    this.onHurt(pos)
    if (this.run.phase !== 'playing') return
    this.dimension = this.checkpointDimension
    this.world.setDimension(this.dimension)
    this.syncDimensionContent()
    this.player.setGravityDirection(this.checkpointGravity)
    this.physics.world.gravity = { x: 0, y: CONFIG.player.gravity * this.checkpointGravity, z: 0 }
    const anchor = this.world.checkpointAnchorIndex(this.checkpointIndex)
    const checkpoint = this.world.anchorPosition(anchor, this.dimension, this.checkpointGravity)
    this.player.teleport(checkpoint)
    this.cam.reset(checkpoint)
    this.hooks.phaseChange(this.dimension)
    this.hooks.gravityChange(this.checkpointGravity)
  }

  private onPlayerEvent(event: PlayerEvent, pos: THREE.Vector3): void {
    const sign = this.player.gravitySign
    const support = pos.y - sign * (CONFIG.player.halfHeight + CONFIG.player.radius)
    const point = pos.clone().setY(support)
    if (event.type === 'jump') {
      this.audio.play('jump')
      this.fx.puff(point, 0.35)
      if (this.tutorial === 'jump') this.advanceTutorial('dimension')
    } else if (event.type === 'land') {
      this.audio.play('land')
      this.fx.puff(point, event.impact)
      if (event.impact > 0.45) this.cam.addShake(event.impact * 0.42)
    } else if (event.type === 'dash') {
      this.audio.play('dash')
      this.fx.burst(pos, '#61e9ff', 12, 3)
    }
  }

  private onHurt(pos: THREE.Vector3): void {
    this.audio.play('hurt')
    this.cam.addShake(0.72)
    this.fx.burst(pos, '#ff4d83', 24, 7)
    this.hooks.hurt()
    this.hooks.popup('-1', this.project(pos.clone().setY(pos.y + 0.8)), 'hurt')
  }

  private updateTutorial(pos: THREE.Vector3): void {
    if (this.tutorial === 'move' && pos.distanceTo(this.tutorialStart) > 2.5) this.advanceTutorial('jump')
    if (this.tutorial === 'cores' && this.run.collected > 0) {
      this.advanceTutorial(null)
      this.hooks.tutorialDone()
    }
  }

  private advanceTutorial(next: Hint | null): void {
    this.tutorial = next
    this.hooks.hint(next)
  }

  private syncDimensionContent(): void {
    for (let index = 0; index < this.cores.length; index += 1) this.cores[index].group.visible = index === this.dimension
  }

  private groundBelow(position: THREE.Vector3): number | null {
    const support = this.world.supportAt(position, this.dimension, this.player.gravitySign)
    if (support !== null) return support
    this.down.origin = { x: position.x, y: position.y, z: position.z }
    const hit = this.physics.world.castRay(this.down, 30, true, undefined, undefined, this.player.collider)
    return hit ? position.y - hit.timeOfImpact : null
  }
}
