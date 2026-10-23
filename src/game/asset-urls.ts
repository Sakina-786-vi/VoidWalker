/** Use checked-in assets in standalone development; published builds use their registered Storage addresses. */
const localAssets = import.meta.env.DEV

export const GAME_ASSETS = {
  traveler: localAssets
    ? '/assets/models/glitchverse-traveler-animated.glb'
    : '/manus-storage/game/sha256/cf0eed1c240a8fdf71ba40425828f5d44fd7ae3d400b57474f7eeed26458ceb0.glb',
  favicon: localAssets
    ? '/assets/share/favicon.png'
    : '/manus-storage/game/sha256/ceb3f0315a417f1cd58e0c24c4f3b95b15ec76940ac94d3c8cfb4f2ecfa7265b.png',
  og: localAssets
    ? '/assets/share/og.png'
    : '/manus-storage/game/sha256/2da26dfe120afdda59f669331c58db5728471eb09ade7f77e8f0ec0b75a57009.png',
} as const
