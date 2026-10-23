import * as THREE from 'three'
import { CONFIG } from './config'

const C = CONFIG.camera

/**
 * Cinematic side-on follow camera for 2.5D traversal. Its depth is fixed, so A/D and arrow keys
 * map cleanly to screen-horizontal motion while a little perspective reveals the layered worlds.
 */
export class FollowCamera {
  readonly camera = new THREE.PerspectiveCamera(C.fov, 1, 0.1, 320)
  yaw = 0
  pitch = 0
  private readonly focus = new THREE.Vector3()
  private shake = 0

  constructor(_physics: unknown, _exclude?: unknown) {}

  addShake(amount: number): void {
    this.shake = Math.min(1, this.shake + amount)
  }

  /** Snap without smoothing (spawn, respawn). */
  reset(target: THREE.Vector3, _yaw = this.yaw): void {
    this.focus.set(target.x + 3.6, target.y + 1.1, 0)
    this.positionCamera(1, true)
  }

  update(target: THREE.Vector3, _look: { x: number; y: number }, frameSeconds: number, snap = false, reducedMotion = false): void {
    if (this.camera.fov !== C.fov) {
      this.camera.fov = C.fov
      this.camera.updateProjectionMatrix()
    }
    const aimX = target.x + 3.6
    const aimY = target.y + 1.1
    if (snap) this.focus.set(aimX, aimY, 0)
    else {
      const k = 1 - Math.exp(-C.follow * frameSeconds)
      this.focus.x += (aimX - this.focus.x) * k
      this.focus.y += (aimY - this.focus.y) * k * 0.72
    }
    this.positionCamera(frameSeconds, false, reducedMotion)
  }

  private positionCamera(frameSeconds: number, snap: boolean, reducedMotion = false): void {
    const z = C.distance
    const target = new THREE.Vector3(this.focus.x, this.focus.y, 0)
    this.camera.position.set(this.focus.x - 3.6, this.focus.y - 1.1 + C.height * 0.45, z)
    this.camera.lookAt(target)
    if (this.shake > 0 && !reducedMotion) {
      const s = this.shake * this.shake * 0.28
      this.camera.position.x += (Math.random() - 0.5) * s
      this.camera.position.y += (Math.random() - 0.5) * s
    }
    this.shake = snap ? 0 : Math.max(0, this.shake - frameSeconds * 2.5)
  }
}
