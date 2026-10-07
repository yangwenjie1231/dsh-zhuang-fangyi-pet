/**
 * 庄方宜桌宠 · 气泡情境映射（**自动生成，勿手改**）。
 *
 * 由 `tools/prepare-pet.py` 从 `assets/catalog.json` 的 `keys[]` 生成 ——
 * 台账是唯一真相，改归属请改台账再重跑管线，不要改这个文件。
 *
 * `emotes.js` 从这里 re-export，挑选逻辑仍手写在那里。
 * @module src/pet/emotes.data.js
 */

/** 情境 key → 该情境下合适的表情文件（相对 `art/pet/`）。 */
export const EMOTE_BY_KEY = {
  "happy": [
    "bubble/09-finger-heart.png",
    "bubble/14-kiss.png",
    "bubble/15-cheer-up.png",
    "bubble/16-comfort.png",
    "bubble/17-yay.png",
    "bubble/20-thumbs-up.png",
    "bubble/23-you-are-the-best.png",
    "bubble/new/04-definitely.png",
    "bubble/new/13-so-good.png",
    "bubble/new/14-so-strong.png",
  ],
  "notify-complete": [
    "bubble/17-yay.png",
    "bubble/20-thumbs-up.png",
    "bubble/23-you-are-the-best.png",
    "bubble/new/04-definitely.png",
    "bubble/new/05-wink.png",
    "bubble/new/09-got-it.png",
    "bubble/new/13-so-good.png",
  ],
  "working": [
    "bubble/21-at-work.png",
    "bubble/25-reading.png",
    "bubble/new/06-brain-overload.png",
    "bubble/new/07-wants.png",
    "bubble/new/19-slacking.png",
  ],
  "thinking": [
    "bubble/18-confused.png",
    "bubble/25-reading.png",
    "bubble/new/01-bored.png",
    "bubble/new/06-brain-overload.png",
  ],
  "waiting": [
    "bubble/new/01-bored.png",
    "bubble/new/07-wants.png",
    "bubble/new/15-so-loud.png",
    "bubble/new/16-knock-knock.png",
  ],
  "error": [
    "bubble/22-annoyed.png",
    "bubble/angry-charge.gif",
    "bubble/new/10-hate-you.png",
    "bubble/new/17-crying.png",
    "bubble/new/18-disgusted.png",
    "bubble/new/20-unhappy.png",
  ],
  "tool/failed": [
    "bubble/22-annoyed.png",
    "bubble/angry-charge.gif",
    "bubble/new/18-disgusted.png",
    "bubble/new/20-unhappy.png",
  ],
  "inbox/inserted": [
    "bubble/08-love-you.png",
    "bubble/09-finger-heart.png",
    "bubble/10-blep.png",
    "bubble/11-hi.png",
    "bubble/13-wink.png",
    "bubble/19-thanks.png",
    "bubble/new/08-miss-you.png",
    "bubble/new/16-knock-knock.png",
  ],
  "idle": [
    "bubble/gif-24.png",
    "bubble/gif-26.png",
    "bubble/gif-28.png",
    "bubble/gif-29.png",
    "bubble/25-reading.png",
    "bubble/new/01-bored.png",
    "bubble/new/11-sneak-snack.png",
    "bubble/new/19-slacking.png",
  ],
  "sleeping": [
    "bubble/gif-24.png",
    "bubble/new/03-dazed.png",
  ],
  "waking": [
    "bubble/12-good-night.png",
    "bubble/new/02-good-morning.png",
    "bubble/new/12-wake-up.png",
  ],
}

/** 全池回落时排除掉这些 —— 它们语义太强，随机撒容易莫名其妙。 */
export const EMOTE_EXCLUDE_FROM_RANDOM = [
  "bubble/12-good-night.png",
  "bubble/14-kiss.png",
  "bubble/16-comfort.png",
  "bubble/19-thanks.png",
]
