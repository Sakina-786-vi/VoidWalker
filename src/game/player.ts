import * as THREE from 'three'
import { RAPIER, type Physics } from '../engine/physics'
import { CONFIG } from './config'
import { tuning } from './tuning'

export type PlayerIntent = { moveX: number; moveY: number; sprint: boolean; jumpPressed: boolean; jumpHeld: boolean; dashPressed: boolean }
export type PlayerEvent = { type: 'jump' } | { type: 'land'; impact: number } | { type: 'dash' }

const P = CONFIG.player
const UP = new THREE.Vector3(0, 1, 0)

/**
 * Rapier's kinematic character controller owns precise contact and wall sliding. This class keeps
 * the starter's buffered jump, coyote time, variable-height jump, dash, safety point and animation,
 * while constraining movement to a side-on plane and letting the controller's up axis flip.
 */
export class Player {
  readonly root = new THREE.Group()
  readonly body: RAPIER.RigidBody
  readonly collider: RAPIER.Collider
  readonly velocity = new THREE.Vector3()
  grounded = false
  facing = 1
  gravitySign: 1 | -1 = 1
  private readonly controller: RAPIER.KinematicCharacterController
  private readonly model = new THREE.Group()
  private readonly traveler = new THREE.Group()
  private readonly eyes: THREE.Mesh
  private readonly shadow: THREE.Mesh
  private coyote = 0
  private jumpBuffer = 0
  private jumping = false
  private dashTime = 0
  private dashCooldown = 0
  private squash = 0
  private runCycle = 0
  private safeTimer = 0
  private mixer?: THREE.AnimationMixer
  private idleAction?: THREE.AnimationAction
  private walkAction?: THREE.AnimationAction
  private activeAction?: THREE.AnimationAction
  /** Last stable foothold; Game uses its own persistent checkpoint for run resets. */
  readonly safe = new THREE.Vector3()

  constructor(private readonly physics: Physics, spawn: THREE.Vector3, _legacyMovers: readonly unknown[] = []) {
    const world = physics.world
    this.body = world.createRigidBody(RAPIER.RigidBodyDesc.kinematicPositionBased().setTranslation(spawn.x, spawn.y, spawn.z))
    this.collider = world.createCollider(RAPIER.ColliderDesc.capsule(P.halfHeight, P.radius).setFriction(0), this.body)
    this.controller = world.createCharacterController(0.02)
    this.controller.enableAutostep(0.35, 0.25, false)
    this.controller.enableSnapToGround(0.32)
    this.controller.setUp(UP)
    this.controller.setMaxSlopeClimbAngle(THREE.MathUtils.degToRad(50))
    this.controller.setMinSlopeSlideAngle(THREE.MathUtils.degToRad(35))
    this.controller.setApplyImpulsesToDynamicBodies(true)
    this.safe.copy(spawn)

    this.root.position.copy(spawn)
    this.eyes = this.buildModel()
    this.model.rotation.order = 'YXZ'
    this.root.add(this.model, this.traveler)
    physics.bind(this.body, this.root)

    this.shadow = new THREE.Mesh(
      new THREE.CircleGeometry(P.radius * 1.35, 28),
      new THREE.MeshBasicMaterial({ color: '#080b17', transparent: true, opacity: 0.48, depthWrite: false }),
    )
    this.shadow.rotation.x = -Math.PI / 2
    this.shadow.renderOrder = 1
  }

  get shadowMesh(): THREE.Mesh { return this.shadow }
  get position(): THREE.Vector3 {
    const t = this.body.translation()
    return new THREE.Vector3(t.x, t.y, t.z)
  }
  get dashing(): boolean { return this.dashTime > 0 }

  /** Replace the fallback suit with the Blueprint-approved rigged model and its baked clips. */
  setTraveler(model: THREE.Object3D, clips: THREE.AnimationClip[]): void {
    const bounds = new THREE.Box3().setFromObject(model)
    const size = bounds.getSize(new THREE.Vector3())
    const height = Math.max(0.01, size.y)
    const scale = 1.62 / height
    model.scale.setScalar(scale)
    model.position.y = -((bounds.min.y + bounds.max.y) * 0.5) * scale
    model.traverse(object => {
      const mesh = object as THREE.Mesh
      if (mesh.isMesh) {
        mesh.castShadow = true
        mesh.receiveShadow = true
      }
    })
    this.traveler.clear()
    this.traveler.add(model)
    this.mixer = new THREE.AnimationMixer(model)
    const idle = clips.find(clip => /idle|relax|stand/i.test(clip.name))
    const walk = clips.find(clip => /walk|run/i.test(clip.name))
    this.idleAction = idle ? this.mixer.clipAction(idle) : undefined
    this.walkAction = walk ? this.mixer.clipAction(walk) : undefined
    this.activeAction = undefined
    this.model.visible = false
  }

  /** `cameraYaw` remains in the call signature for starter compatibility; the camera is now fixed. */
  step(dt: number, intent: PlayerIntent, cameraYaw: number, events: PlayerEvent[]): void {
    void cameraYaw
    const wish = new THREE.Vector3(Math.sign(intent.moveX) * Math.min(1, Math.abs(intent.moveX)), 0, 0)
    const wishLen = Math.abs(wish.x)
    const sign = this.gravitySign

    this.coyote = this.grounded ? P.coyoteTime : Math.max(0, this.coyote - dt)
    this.jumpBuffer = intent.jumpPressed ? P.jumpBuffer : Math.max(0, this.jumpBuffer - dt)
    this.dashCooldown = Math.max(0, this.dashCooldown - dt)

    if (intent.dashPressed && this.dashCooldown <= 0) {
      tuning.activate('dash')
      const dir = wishLen > 0.01 ? wish : new THREE.Vector3(this.facing, 0, 0)
      this.facing = dir.x < 0 ? -1 : 1
      this.velocity.x = dir.x * P.dashSpeed
      this.dashTime = P.dashTime
      this.dashCooldown = P.dashCooldown
      events.push({ type: 'dash' })
    }

    if (this.dashTime > 0) {
      this.dashTime = Math.max(0, this.dashTime - dt)
    } else {
      const speed = (intent.sprint ? P.sprintSpeed : P.walkSpeed) * wishLen
      const control = this.grounded ? 1 : P.airControl
      this.velocity.x = THREE.MathUtils.damp(this.velocity.x, wish.x * speed, (P.acceleration / 6) * control, dt)

      if (this.jumpBuffer > 0 && this.coyote > 0) {
        tuning.activate('jump')
        this.velocity.y = sign * P.jumpSpeed
        this.jumping = true
        this.jumpBuffer = 0
        this.coyote = 0
        this.grounded = false
        this.squash = -0.35
        events.push({ type: 'jump' })
      }
      const rising = this.velocity.y * sign > 0
      const gravity = (rising && this.jumping && !intent.jumpHeld ? P.lowJumpGravity : P.gravity) * sign
      this.velocity.y = THREE.MathUtils.clamp(this.velocity.y + gravity * dt, -Math.abs(P.maxFall), Math.abs(P.maxFall))
    }

    if (wishLen > 0.1 && this.dashTime <= 0) this.facing = wish.x < 0 ? -1 : 1

    const desired = this.velocity.clone().multiplyScalar(dt)
    desired.z = -this.root.position.z
    this.controller.computeColliderMovement(this.collider, desired)
    const moved = this.controller.computedMovement()
    const wasGrounded = this.grounded
    this.grounded = this.controller.computedGrounded()

    // Stop on a wall or against the upper surface in the current gravity direction.
    if (this.velocity.y * sign > 0 && moved.y * sign < desired.y * sign - 1e-3) this.velocity.y = 0
    if (this.grounded) {
      if (!wasGrounded && this.velocity.y * sign < 0) {
        events.push({ type: 'land', impact: Math.min(1, Math.abs(this.velocity.y) / 30) })
        this.squash = Math.min(0.45, Math.abs(this.velocity.y) / 60)
      }
      if (this.velocity.y * sign < 0) this.velocity.y = -sign
      this.jumping = false
    }

    const cur = this.body.translation()
    const next = { x: cur.x + moved.x, y: cur.y + moved.y, z: 0 }
    this.body.setNextKinematicTranslation(next)
    if (this.grounded) {
      this.safeTimer += dt
      if (this.safeTimer > 0.25) this.safe.set(next.x, next.y, next.z)
    } else this.safeTimer = 0
  }

  setGravityDirection(sign: 1 | -1): void {
    if (sign === this.gravitySign) return
    this.gravitySign = sign
    this.controller.setUp(new THREE.Vector3(0, sign, 0))
    this.velocity.y = 0
    this.jumping = false
    this.grounded = false
    this.safeTimer = 0
  }

  /** Teleport (checkpoint/respawn). Clears velocity and interpolation so the camera does not streak. */
  teleport(to: THREE.Vector3): void {
    this.body.setTranslation(to, true)
    this.body.setNextKinematicTranslation(to)
    this.velocity.set(0, 0, 0)
    this.dashTime = 0
    this.grounded = false
    this.safeTimer = 0
    this.root.position.copy(to)
    this.safe.copy(to)
    this.physics.snap(this.body)
  }

  /** Knock the player away from a moving energy hazard. */
  knockback(from: THREE.Vector3): void {
    const away = this.position.sub(from).setY(0)
    if (away.lengthSq() < 1e-4) away.set(1, 0, 0)
    away.normalize().multiplyScalar(7.5)
    this.velocity.x = away.x
    this.velocity.y = this.gravitySign * 5.5
    this.dashTime = 0
    this.grounded = false
  }

  /** Visual-only animation, once per rendered frame after physics interpolation. */
  animate(frameSeconds: number, time: number, invulnerable: boolean, ground: number | null): void {
    const speed = Math.abs(this.velocity.x)
    this.squash = THREE.MathUtils.damp(this.squash, 0, 10, frameSeconds)
    const stretch = this.grounded ? 0 : THREE.MathUtils.clamp((this.velocity.y * this.gravitySign) / 65, -0.12, 0.18)
    const s = 1 - this.squash + stretch
    this.model.scale.set(1 / Math.sqrt(Math.max(s, 0.5)), s, 1 / Math.sqrt(Math.max(s, 0.5)))
    const bob = this.grounded && speed > 0.5 ? Math.abs(Math.sin((this.runCycle += frameSeconds * speed * 1.6))) * 0.06 : 0
    this.model.position.y = bob
    this.model.rotation.y = this.facing < 0 ? Math.PI : 0
    this.model.rotation.z = this.gravitySign < 0 ? Math.PI : 0
    this.traveler.rotation.y = this.facing < 0 ? Math.PI : 0
    this.traveler.rotation.z = this.gravitySign < 0 ? Math.PI : 0
    this.traveler.position.y = bob
    this.traveler.scale.y = 1 - this.squash + stretch
    this.traveler.visible = !invulnerable || Math.floor(time * 16) % 2 === 0
    this.model.visible = !this.mixer && (!invulnerable || Math.floor(time * 16) % 2 === 0)
    ;(this.eyes.material as THREE.MeshStandardMaterial).emissiveIntensity = this.dashing ? 4 : 2.2

    if (this.mixer) {
      const wanted = this.grounded && speed > 0.55 ? this.walkAction ?? this.idleAction : this.idleAction ?? this.walkAction
      if (wanted && wanted !== this.activeAction) {
        this.activeAction?.fadeOut(0.16)
        wanted.reset().fadeIn(0.16).play()
        this.activeAction = wanted
      }
      this.mixer.update(frameSeconds)
    }

    // Blob shadow is the reliable platform-depth cue. Its normal flips with gravity.
    if (ground === null) this.shadow.visible = false
    else {
      const supportDistance = Math.abs(this.root.position.y - ground)
      this.shadow.visible = supportDistance < 14
      this.shadow.position.set(this.root.position.x, ground, 0.1)
      this.shadow.rotation.x = this.gravitySign > 0 ? -Math.PI / 2 : Math.PI / 2
      const k = THREE.MathUtils.clamp(1 - Math.max(0, supportDistance - 0.9) / 14, 0.2, 1)
      this.shadow.scale.setScalar(k)
      ;(this.shadow.material as THREE.MeshBasicMaterial).opacity = 0.4 * k
    }
  }

  private buildModel(): THREE.Mesh {
    const shell = new THREE.MeshStandardMaterial({ color: '#e5e6f4', roughness: 0.42, metalness: 0.22 })
    const accent = new THREE.MeshStandardMaterial({ color: '#bd46ff', emissive: '#721dd7', emissiveIntensity: 0.75, roughness: 0.4 })
    const dark = new THREE.MeshStandardMaterial({ color: '#172032', roughness: 0.32, metalness: 0.45 })
    const eyes = new THREE.MeshStandardMaterial({ color: '#76f4ff', emissive: '#39e9ff', emissiveIntensity: 2.2 })
    const torso = new THREE.Mesh(new THREE.CapsuleGeometry(0.34, 0.34, 6, 16), shell)
    torso.position.y = -0.3
    const belt = new THREE.Mesh(new THREE.TorusGeometry(0.36, 0.055, 8, 24), accent)
    belt.rotation.x = Math.PI / 2
    belt.position.y = -0.36
    const head = new THREE.Mesh(new THREE.SphereGeometry(0.39, 24, 16), shell)
    head.position.y = 0.42
    const visor = new THREE.Mesh(new THREE.SphereGeometry(0.33, 24, 12, Math.PI * 0.58, Math.PI * 0.84, Math.PI * 0.28, Math.PI * 0.4), dark)
    visor.position.set(0, 0.42, -0.07)
    visor.rotation.y = Math.PI
    const eyeGeo = new THREE.CapsuleGeometry(0.045, 0.08, 4, 8)
    const eyeL = new THREE.Mesh(eyeGeo, eyes)
    const eyeR = new THREE.Mesh(eyeGeo, eyes)
    eyeL.position.set(-0.12, 0.44, -0.36)
    eyeR.position.set(0.12, 0.44, -0.36)
    const antenna = new THREE.Mesh(new THREE.CylinderGeometry(0.02, 0.02, 0.28, 6), dark)
    antenna.position.set(0.14, 0.9, 0.04)
    const tip = new THREE.Mesh(new THREE.SphereGeometry(0.07, 12, 8), new THREE.MeshStandardMaterial({ color: '#ffc46b', emissive: '#ff8744', emissiveIntensity: 1.5 }))
    tip.position.set(0.14, 1.06, 0.04)
    const pack = new THREE.Mesh(new THREE.BoxGeometry(0.42, 0.44, 0.2), accent)
    pack.position.set(0, -0.2, 0.36)
    const footGeo = new THREE.SphereGeometry(0.16, 12, 8)
    const footL = new THREE.Mesh(footGeo, dark)
    const footR = new THREE.Mesh(footGeo, dark)
    footL.scale.set(1, 0.6, 1.3)
    footR.scale.set(1, 0.6, 1.3)
    footL.position.set(-0.17, -0.84, -0.04)
    footR.position.set(0.17, -0.84, -0.04)
    for (const mesh of [torso, belt, head, visor, antenna, tip, pack, footL, footR, eyeL, eyeR]) {
      mesh.castShadow = true
      this.model.add(mesh)
    }
    return eyeL
  }
}
