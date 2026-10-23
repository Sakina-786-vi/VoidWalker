import './styles/main.css'
import { Audio } from './engine/audio'
import { I18n, resolveLocale } from './engine/i18n'
import { Input } from './engine/input'
import { GameLoop } from './engine/loop'
import { SAVE_KEY, SaveStore, type SaveData } from './engine/save'
import type { Game } from './game/game'
import { GAME_ASSETS } from './game/asset-urls'
import { TouchControls } from './ui/touch'
import { Ui } from './ui/ui'

async function boot(): Promise<void> {
  const canvas = document.querySelector<HTMLCanvasElement>('#game')!
  const firstRun = safeGet(SAVE_KEY) === null
  const save = new SaveStore()

  const i18n = new I18n(resolveLocale(save.data.locale, navigator.languages))
  const input = new Input(canvas)
  const audio = new Audio()
  let game: Game | undefined

  const applySettings = (d: SaveData) => {
    input.sensitivity = d.sensitivity
    input.invertY = d.invertY
    audio.setVolumes(d.musicVolume, d.sfxVolume, d.muted)
    if (game) game.reducedMotion = d.reducedMotion
  }

  const startRun = (tutorial: boolean) => {
    if (!game) return
    audio.unlock()
    audio.startMusic()
    game.start(tutorial)
    ui.show('hud')
    loop.resetAccumulator()
  }
  const pause = () => {
    if (game?.mode !== 'playing') return
    game.pause()
    ui.show('pause')
  }
  const resume = () => {
    if (game?.mode !== 'paused') return
    game.resume()
    ui.show('hud')
    loop.resetAccumulator()
  }

  const ui = new Ui(i18n, save, audio, input, {
    play: () => startRun(!save.data.tutorialDone),
    restart: () => startRun(false),
    resume,
    quit: () => {
      game?.toTitle()
      ui.show('title')
    },
    settings: patch => {
      const qualityChanged = patch.quality !== undefined && patch.quality !== save.data.quality
      save.update(patch)
      applySettings(save.data)
      if (patch.locale) i18n.set(patch.locale)
      if (qualityChanged) game?.setQuality(save.data.quality)
    },
  })
  ui.show('boot')
  const bootFavicon = document.querySelector<HTMLImageElement>('#ui .boot-favicon')
  if (bootFavicon && GAME_ASSETS.favicon) bootFavicon.src = GAME_ASSETS.favicon
  applySettings(save.data)

  // Boot: the UI above is already on screen; three.js, Rapier (WASM) and the game load as a
  // separate chunk behind the progress bar. Preload models/textures here too (engine/assets.ts).
  let loaded = 0
  const track = <T>(p: Promise<T>): Promise<T> => p.then(v => (ui.setBootProgress(0.1 + (++loaded / 5) * 0.9), v))
  ui.setBootProgress(0.1)
  const [{ Game }, { Renderer, suggestQuality }, physics] = await Promise.all([
    track(import('./game/game')),
    track(import('./engine/renderer')),
    track(import('./engine/physics')),
    track(document.fonts.ready),
  ])
  await physics.initPhysics()
  if (firstRun) {
    save.update({ quality: suggestQuality() })
    ui.refreshSettings()
  }

  const renderer = new Renderer(canvas, save.data.quality)
  game = new Game(renderer, input, audio, {
    popup: (text, at, kind) => ui.popup(text, at, kind),
    hurt: () => ui.hurt(),
    hint: hint => ui.hint(hint),
    tutorialDone: () => save.update({ tutorialDone: true }),
    phaseChange: dimension => ui.phaseChange(dimension),
    checkpoint: index => ui.checkpoint(index),
    gravityChange: sign => ui.gravityChange(sign),
    freezeChange: seconds => ui.freezeChange(seconds),
    end: run => {
      window.setTimeout(() => ui.showResults(run), run.phase === 'won' ? 1400 : 900)
    },
  })
  game.reducedMotion = save.data.reducedMotion
  if (GAME_ASSETS.traveler) await track(game.loadTraveler(GAME_ASSETS.traveler))
  if (import.meta.env.DEV) {
    const [{ registerGameTuning }, { tuning }] = await Promise.all([
      import('../scripts/manus-tuning/adapter.js'), import('./game/tuning'),
    ])
    await registerGameTuning(tuning)
  }
  const g = game

  const loop = new GameLoop({
    step: dt => g.step(dt),
    render: (alpha, frameSeconds) => {
      input.update()
      if (input.consume('pause')) {
        if (g.mode === 'playing') pause()
        else if (g.mode === 'paused' && ui.screen === 'pause') resume()
      }
      ui.frame(frameSeconds)
      loop.paused = g.mode === 'paused'
      g.render(alpha, frameSeconds)
      ui.updateWorld(g.dimension, g.gravitySign, g.freezeSeconds, g.nextDimension, g.playerPosition.x / 90)
      if (g.mode === 'playing' || g.mode === 'ended') ui.updateHud(g.run, g.compass())
    },
  })
  loop.start()

  document.addEventListener('visibilitychange', () => {
    if (document.hidden) pause()
  })
  window.addEventListener('game:pause', pause)
  new TouchControls(document.getElementById('ui')!, input, () => g.mode === 'playing')

  window.setTimeout(() => ui.show('title'), 250)
  // Debug/test hook (read-only use): smoke tests inspect run state through it.
  ;(window as unknown as { __game: unknown }).__game = { game: g, ui, input, save }
}

function safeGet(key: string): string | null {
  try {
    return localStorage.getItem(key)
  } catch {
    return null
  }
}

boot().catch(err => {
  console.error(err)
  const el = document.getElementById('ui')
  if (el) {
    const chinese = document.documentElement.lang === 'zh-CN'
    const detail = String((err as Error)?.message ?? err).replace(/[<>&]/g, '')
    const icon = GAME_ASSETS.favicon ? `<img class="boot-favicon" src="${GAME_ASSETS.favicon}" alt="">` : ''
    el.innerHTML = `<section class="screen screen-boot is-active"><div class="boot-failure">${icon}<h1>GLITCHVERSE</h1><p>${chinese ? '世界加载失败，请重试。' : 'The world failed to load. Please retry.'}</p><small>${detail}</small><button class="btn btn-primary" data-boot-retry>${chinese ? '重试' : 'Retry'}</button></div></section>`
    el.querySelector('[data-boot-retry]')?.addEventListener('click', () => window.location.reload())
  }
})
