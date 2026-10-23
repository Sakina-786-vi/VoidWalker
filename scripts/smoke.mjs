// End-to-end GLITCHVERSE smoke test: builds must already exist in dist/ (`pnpm build`).
// Locally maps managed-storage requests to the same registered project files so Vite preview
// can exercise the actual loader without relying on the hosted storage proxy.
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { chromium } from 'playwright'

const root = process.cwd()
const port = 4300 + Math.floor(Math.random() * 500)
const url = `http://127.0.0.1:${port}/`
const out = process.env.SHOTS_DIR ?? 'shots'
const traveler = resolve(root, 'assets/models/glitchverse-traveler-animated.glb')
const favicon = resolve(root, 'assets/share/favicon.png')
if (!existsSync(traveler) || !existsSync(favicon)) throw new Error('Registered traveler and favicon must exist before smoke tests run.')
mkdirSync(out, { recursive: true })

const server = spawn(process.execPath, ['node_modules/vite/bin/vite.js', 'preview', '--port', String(port), '--strictPort', '--host', '127.0.0.1'], { stdio: 'ignore', detached: false })
let browser
const guard = setTimeout(() => fail('timed out'), 120_000)

function cleanup() {
  clearTimeout(guard)
  try { server.kill('SIGTERM') } catch {}
}
async function fail(msg) {
  console.error(`smoke: FAIL — ${msg}`)
  await browser?.close().catch(() => {})
  cleanup()
  process.exit(1)
}
async function waitForServer() {
  for (let i = 0; i < 60; i += 1) {
    try {
      if ((await fetch(url)).ok) return
    } catch {}
    await new Promise(r => setTimeout(r, 250))
  }
  throw new Error('preview server did not start')
}
async function openGame(context, errors, captureBoot = false) {
  const page = await context.newPage()
  page.on('console', message => message.type() === 'error' && errors.push(message.text()))
  page.on('pageerror', error => errors.push(String(error)))
  page.on('response', response => response.status() >= 400 && errors.push(`HTTP ${response.status()} ${response.url()}`))
  await page.route('**/manus-storage/**', async route => {
    const image = route.request().resourceType() === 'image'
    if (captureBoot && !image) await page.waitForTimeout(1_250)
    await route.fulfill({ path: image ? favicon : traveler })
  })
  await page.goto(url)
  if (captureBoot) {
    await page.waitForSelector('[data-screen="boot"].is-active', { timeout: 10_000 })
    await page.waitForFunction(() => {
      const icon = document.querySelector('.boot-favicon')
      return icon instanceof HTMLImageElement && icon.complete && icon.naturalWidth === 128
    }, undefined, { timeout: 5_000 })
    await page.waitForTimeout(150)
    await page.screenshot({ path: `${out}/00-boot.png` })
  }
  await page.waitForSelector('[data-screen="title"].is-active', { timeout: 30_000 })
  await page.evaluate(async () => {
    await document.fonts.ready
    const expected = document.documentElement.lang === 'zh-CN' ? 'ManusCC0 Sans CJK SC' : 'ManusCC0'
    for (const selector of ['.logo-text', '.tagline']) {
      const family = getComputedStyle(document.querySelector(selector)).fontFamily
      if (!family.startsWith(`"${expected}"`) && !family.startsWith(expected + ',')) throw new Error(`Unexpected game font: ${family}`)
    }
    if (![...document.fonts].some(face => face.family.replaceAll('"', '').replaceAll("'", '') === expected && face.status === 'loaded')) {
      throw new Error(`Bundled font did not load: ${expected}`)
    }
  })
  await page.waitForFunction(() => window.__game?.game?.player?.traveler?.children?.length > 0, undefined, { timeout: 15_000 })
  await page.waitForTimeout(450)
  return page
}
const state = page => page.evaluate(() => {
  const { game } = window.__game
  const p = game.playerPosition
  return {
    mode: game.mode,
    run: game.run,
    dimension: game.dimension,
    gravity: game.gravitySign,
    freezeSeconds: game.freezeSeconds,
    grounded: game.player.grounded,
    velocityY: game.player.velocity.y,
    jumpBuffer: game.player['jumpBuffer'],
    coyote: game.player['coyote'],
    jumping: game.player['jumping'],
    jumpHeld: window.__game.input.held('jump'),
    jumpPressed: window.__game.input.pressed('jump'),
    pos: { x: p.x, y: p.y, z: p.z },
  }
})

try {
  await waitForServer()
  const args = ['--ignore-gpu-blocklist']
  browser = await chromium.launch({ args }).catch(() => chromium.launch({ args, channel: 'chrome' }))
  const errors = []

  const en = await browser.newContext({ viewport: { width: 1280, height: 720 }, locale: 'en-US' })
  const page = await openGame(en, errors, true)
  await page.screenshot({ path: `${out}/01-title-en.png` })

  await page.click('[data-action="play"]')
  await page.waitForSelector('[data-screen="hud"].is-active')
  const start = await state(page)
  await page.keyboard.down('KeyD')
  await page.waitForTimeout(650)
  await page.keyboard.up('KeyD')
  await page.waitForTimeout(120)
  const walked = await state(page)
  const distance = Math.hypot(walked.pos.x - start.pos.x, walked.pos.z - start.pos.z)
  if (walked.mode !== 'playing' || distance < 2) throw new Error(`A/D did not move the traveler (${distance.toFixed(2)} m)`)

  // The movement measurement can end at the edge of a bridge; test jumping from a real, stable floor.
  await page.evaluate(() => {
    const { game } = window.__game
    game.player.teleport(game['world'].spawn)
  })
  await page.waitForFunction(() => window.__game.game.player.grounded, undefined, { timeout: 3_000 })
  const readyToJump = await state(page)
  await page.keyboard.down('Space')
  await page.waitForTimeout(100)
  const whileJumpHeld = await state(page)
  await page.keyboard.up('Space')
  await page.waitForFunction(() => window.__game.game.player.grounded, undefined, { timeout: 3_000 })
  const jumped = await state(page)
  if (whileJumpHeld.pos.y < readyToJump.pos.y + 0.15) throw new Error(`Space did not produce a visible jump (ready=${JSON.stringify(readyToJump)}, held=${JSON.stringify(whileJumpHeld)}, landed=${JSON.stringify(jumped)})`)
  if (!jumped.grounded) throw new Error('The traveler failed to land after the jump')
  await page.waitForTimeout(900)

  // Phase-shift through the real E/Q bindings from a shared safe anchor.
  await page.evaluate(() => {
    const { game } = window.__game
    game.player.teleport(game['world'].spawn)
  })
  await page.waitForTimeout(80)
  await page.keyboard.press('KeyE')
  await page.waitForFunction(() => window.__game.game.dimension === 1, undefined, { timeout: 2_000 })
  if (!(await page.locator('#ui').getAttribute('data-dimension') === 'fantasy')) throw new Error('Fantasy phase state was not reflected in the HUD')
  await page.waitForTimeout(500)
  await page.screenshot({ path: `${out}/02-fantasy.png` })
  await page.keyboard.press('KeyQ')
  await page.waitForFunction(() => window.__game.game.dimension === 0, undefined, { timeout: 2_000 })

  // Gravity inversion must be a real Rapier controller state change and must land safely on its ceiling route.
  await page.keyboard.press('KeyG')
  await page.waitForFunction(() => window.__game.game.gravitySign === -1, undefined, { timeout: 2_000 })
  await page.waitForFunction(() => window.__game.game.player.grounded, undefined, { timeout: 7_000 })
  await page.keyboard.press('KeyG')
  await page.waitForFunction(() => window.__game.game.gravitySign === 1, undefined, { timeout: 2_000 })
  await page.keyboard.press('KeyT')
  await page.waitForFunction(() => window.__game.game.freezeSeconds > 3, undefined, { timeout: 2_000 })
  await page.waitForTimeout(120)
  await page.screenshot({ path: `${out}/03-future-gameplay.png` })

  // A forced below-map fall should consume a life and recover to the saved anchor without ending the run.
  const beforeFall = await state(page)
  await page.evaluate(() => {
    const { game } = window.__game
    const p = game.playerPosition
    game.player.teleport({ x: p.x, y: -30, z: 0 })
  })
  await page.waitForFunction(() => window.__game.game.playerPosition.y > -8, { timeout: 3_000 })
  const afterRespawn = await state(page)
  if (!(afterRespawn.run.lives < beforeFall.run.lives) || afterRespawn.mode !== 'playing') throw new Error('Fall recovery did not preserve the run and consume a life')

  await page.keyboard.press('Escape')
  await page.waitForSelector('[data-screen="pause"].is-active')
  await page.waitForTimeout(250)
  await page.screenshot({ path: `${out}/04-pause.png` })
  await page.click('[data-screen="pause"] [data-action="settings"]')
  await page.waitForSelector('[data-screen="settings"].is-active')
  await page.waitForTimeout(250)
  await page.screenshot({ path: `${out}/05-settings.png` })
  await page.keyboard.press('Escape')
  await page.waitForSelector('[data-screen="pause"].is-active')
  if ((await state(page)).mode !== 'paused') throw new Error('Leaving Settings with Escape unexpectedly resumed gameplay')
  await page.click('[data-screen="pause"] [data-action="resume"]')
  await page.waitForFunction(() => window.__game.game.mode === 'playing')

  // Collect both realm inventories via the same fixed-step pickup/rules path to exercise the real win state.
  await page.evaluate(() => {
    const { game } = window.__game
    game.start(false)
    for (const dimension of [0, 1]) {
      game['world'].setDimension(dimension, true)
      game.dimension = dimension
      game['hooks'].phaseChange(dimension)
      for (const item of game['cores'][dimension].remaining()) {
        game.player.teleport(item)
        game.step(1 / 60)
      }
    }
  })
  await page.waitForSelector('[data-screen="results"].is-active', { timeout: 10_000 })
  await page.waitForTimeout(700)
  await page.screenshot({ path: `${out}/06-results.png` })
  const done = await state(page)
  if (done.run.phase !== 'won') throw new Error(`Expected a won run after all shards, got ${done.run.phase}`)
  console.log(`smoke: moved ${distance.toFixed(1)} m, collected ${done.run.collected} shards across both realms, won run`)
  await en.close()

  const zh = await browser.newContext({ viewport: { width: 1280, height: 720 }, locale: 'zh-CN' })
  const zhPage = await openGame(zh, errors)
  if (await zhPage.evaluate(() => document.documentElement.lang) !== 'zh-CN') throw new Error('Chinese browser locale was not selected')
  await zhPage.screenshot({ path: `${out}/07-title-zh.png` })
  await zh.close()

  const phone = await browser.newContext({ viewport: { width: 844, height: 390 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, locale: 'zh-CN' })
  const phonePage = await openGame(phone, errors)
  await phonePage.tap('[data-action="play"]')
  await phonePage.waitForSelector('[data-screen="hud"].is-active')
  await phonePage.waitForTimeout(450)
  if (!(await phonePage.locator('.touch-phase').isVisible())) throw new Error('Touch dimension-switch button is not visible on mobile')
  await phonePage.screenshot({ path: `${out}/08-phone-hud.png` })
  await phone.close()

  if (errors.length) throw new Error(`console errors:\n  ${errors.join('\n  ')}`)
  await browser.close()
  cleanup()
  console.log(`smoke: OK — screenshots in ${out}/`)
} catch (err) {
  await fail(err?.message ?? String(err))
}
