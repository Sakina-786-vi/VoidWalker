# GLITCHVERSE — The World Is Broken

A playable 2.5D multiverse puzzle-platformer built on the starter's Three.js, Rapier and Vite architecture. Cross the **Sabotaged Future** and **Forgotten Fantasy** by switching dimensions at stable anchor platforms, collecting memory shards, reversing gravity and freezing moving energy hazards.

## Run and verify

```bash
pnpm install
pnpm build
pnpm test
pnpm exec playwright install chromium # one-time setup before first smoke test
pnpm smoke      # after build; browser playthrough and screenshots in shots/
```

On Windows PowerShell, start the local dev server with:

```powershell
pnpm dev
```

Vite uses port `3000` by default. To expose it on your network, set the environment variables in PowerShell before starting it:

```powershell
$env:PORT = "3000"; $env:HOST = "0.0.0.0"; pnpm dev
```

The game is designed for a fixed side-on camera and the included 2.5D route. It has procedural atmospheric scenery, distinct physics layers for each dimension, checkpoints, pickups, fall recovery, a responsive HUD, and a rigged traveler with baked idle/walk animation clips.

## Controls

| Action | Keyboard | Gamepad / touch |
| --- | --- | --- |
| Move | A / D or Left / Right | Left stick / left-side virtual stick |
| Jump | Space | A / jump button |
| Switch dimension | Q or E (only at a safe anchor) | X / SHIFT button |
| Reverse gravity | G (from a supported platform) | Y / FLIP button |
| Freeze active hazards | T | B / FREEZE button |
| Dash | F or Shift | RB / DASH button |
| Pause | Esc | Start / in-game pause button |

## Architecture

| Path | Role |
| --- | --- |
| `src/engine/loop.ts`, `physics.ts`, `renderer.ts` | Fixed-step simulation, Rapier and WebGL renderer |
| `src/engine/input.ts` | Keyboard/gamepad/touch action abstraction |
| `src/engine/assets.ts` | Shared loader utilities and asset progress |
| `src/game/world.ts` | Route layout, both realm layers, platforms, atmosphere and hazards |
| `src/game/player.ts` | Rapier character controller, gravity orientation, suit and animation mixer |
| `src/game/game.ts` | Input, phase shifts, puzzle gates, pickups, checkpointing and recovery |
| `src/game/camera.ts`, `collectibles.ts`, `fx.ts` | Side-on camera, objective objects and visual effects |
| `src/game/tuning.ts` | Game-owned preview parameter manager |
| `src/ui/`, `src/styles/main.css` | HTML/CSS title, phase HUD, pause, settings and results screens |
| `src/i18n/*.json` | English and Simplified Chinese UI copy |

## Credits and licenses

The starter's font assets remain intact: ManusCC0 and ManusCC0 Sans CJK SC are CC0 1.0; see `public/fonts/ManusCC0-LICENSE.txt`. Runtime libraries include three.js (MIT) and Rapier (Apache-2.0). The generated game character and art are registered in the project's managed asset workflow.

## Preview Tweak

`src/game/tuning.ts` remains this game's parameter manager. The Addon panel reads its catalog; `config.ts` owns source defaults and the active configuration used by gameplay. Keep only controls with actual gameplay consumers and stable IDs for unchanged parameters. The Vite plugin and `scripts/__manus__/` helpers remain development-only; production builds exclude the browser adapter and never inject the bridge.

Apply changes preview state only. `LIVE` parameters are read in the next game update; `NEXT_ACTION` parameters activate at jump/dash start; `NEXT_RUN` parameters activate in `Game.start`. Model/collider size and gravity are intentionally not exposed by this version. Do not mutate source defaults or persist Apply to localStorage. Save with Manus validates the snapshot against the current catalog and edits `DEFAULT_CONFIG`, then uses the normal Three.js Web build/checkpoint workflow.

For server-authoritative multiplayer, expose local cosmetic controls only until gameplay parameters have explicit server-side development support. The descriptor's GAMEPLAY flag is classification, not server authorization or ranked-score enforcement.

The preview plugin reads the ignored `.manus-webdev/preview-identity.json` written by the Runtime. The manager latches `tuning.unranked` when non-default GAMEPLAY values become active and resets it only at the next run. `Game` snapshots this onto `RunState.unranked`; local results cannot save such runs. Preserve this guard when changing scoring.
