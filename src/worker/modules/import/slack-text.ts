// Converts message text from a Slack workspace export into Huddle's format. The export format is
// documented publicly (Slack help centre: "How to read Slack data exports"; API docs: formatting).

/** Common emoji names used in reactions. Custom workspace emoji have no Unicode form and are skipped. */
const SHORTCODES: Record<string, string> = {
  '+1': '👍',
  thumbsup: '👍',
  '-1': '👎',
  thumbsdown: '👎',
  ok_hand: '👌',
  clap: '👏',
  raised_hands: '🙌',
  pray: '🙏',
  muscle: '💪',
  wave: '👋',
  point_up: '☝️',
  point_right: '👉',
  eyes: '👀',
  heart: '❤️',
  heart_eyes: '😍',
  smile: '😄',
  smiley: '😃',
  grinning: '😀',
  joy: '😂',
  laughing: '😆',
  sweat_smile: '😅',
  rofl: '🤣',
  slightly_smiling_face: '🙂',
  wink: '😉',
  blush: '😊',
  thinking_face: '🤔',
  neutral_face: '😐',
  confused: '😕',
  cry: '😢',
  sob: '😭',
  scream: '😱',
  rage: '😡',
  sunglasses: '😎',
  party: '🥳',
  partying_face: '🥳',
  tada: '🎉',
  fire: '🔥',
  rocket: '🚀',
  star: '⭐',
  sparkles: '✨',
  zap: '⚡',
  white_check_mark: '✅',
  heavy_check_mark: '✔️',
  check: '✔️',
  x: '❌',
  warning: '⚠️',
  no_entry: '⛔',
  question: '❓',
  exclamation: '❗',
  bulb: '💡',
  memo: '📝',
  pushpin: '📌',
  calendar: '📅',
  coffee: '☕',
  beer: '🍺',
  pizza: '🍕',
  cake: '🍰',
  moneybag: '💰',
  chart_with_upwards_trend: '📈',
  bug: '🐛',
  wrench: '🔧',
  hammer: '🔨',
  lock: '🔒',
  key: '🔑',
  bell: '🔔',
  mega: '📣',
  speech_balloon: '💬',
  hourglass: '⌛',
  stopwatch: '⏱️',
  '100': '💯',
  trophy: '🏆',
  medal: '🏅',
  gift: '🎁',
  see_no_evil: '🙈',
  facepalm: '🤦',
  shrug: '🤷',
  handshake: '🤝',
  saluting_face: '🫡',
  melting_face: '🫠',
  skull: '💀',
  ghost: '👻',
  robot_face: '🤖',
  house: '🏠',
  car: '🚗',
  airplane: '✈️',
  sunny: '☀️',
  rain_cloud: '🌧️',
  snowflake: '❄️',
  earth_africa: '🌍',
  seedling: '🌱',
  dog: '🐶',
  cat: '🐱',
};

/** Slack reaction name (with optional ::skin-tone-N) → Unicode emoji, or null for custom emoji. */
export function emojiFromShortcode(name: string): string | null {
  const [base, tone] = name.split('::');
  const emoji = base ? SHORTCODES[base] : undefined;
  if (!emoji) return null;
  const tones: Record<string, string> = {
    'skin-tone-2': '\u{1F3FB}',
    'skin-tone-3': '\u{1F3FC}',
    'skin-tone-4': '\u{1F3FD}',
    'skin-tone-5': '\u{1F3FE}',
    'skin-tone-6': '\u{1F3FF}',
  };
  return tone && tones[tone] ? emoji + tones[tone] : emoji;
}

/**
 * Rewrites Slack's markup:
 * - <@U123> → <@huddleUserId> (or @name when the person was not imported);
 * - <#C123|general> → #general; <!here> → <@here>; <!channel>/<!everyone> → <@channel>;
 * - <https://x|label> → [label](https://x); <https://x> → https://x; <mailto:a@b|a@b> → a@b;
 * - *bold* → **bold**; ~strike~ → ~~strike~~ (_italic_ and `code` are the same in both);
 * - &lt; &gt; &amp; are unescaped last, so Slack's own markup is converted before any literal "<"
 *   appears. (Text that spells out a Huddle token, e.g. "<@here>", then behaves exactly as if it had
 *   been typed into Huddle.)
 */
export function convertSlackText(
  text: string,
  userIds: Map<string, string>,
  names: Map<string, string>,
): string {
  const converted = text
    .replace(/<@([UW][A-Z0-9]+)(?:\|[^>]*)?>/g, (_, id: string) => {
      const mapped = userIds.get(id);
      return mapped ? `<@${mapped}>` : `@${names.get(id) ?? 'someone'}`;
    })
    .replace(/<#[CG][A-Z0-9]+\|([^>]+)>/g, '#$1')
    .replace(/<#[CG][A-Z0-9]+>/g, '#channel')
    .replace(/<!here(?:\|[^>]*)?>/g, '<@here>')
    .replace(/<!(?:channel|everyone)(?:\|[^>]*)?>/g, '<@channel>')
    .replace(/<!subteam\^[A-Z0-9]+(?:\|([^>]+))?>/g, (_, label?: string) => label ?? '@group')
    .replace(/<!date\^\d+\^[^|>]*\|([^>]+)>/g, '$1')
    .replace(/<mailto:[^|>]+\|([^>]+)>/g, '$1')
    .replace(/<(https?:\/\/[^|>]+)\|([^>]+)>/g, '[$2]($1)')
    .replace(/<(https?:\/\/[^>]+)>/g, '$1')
    .replace(/(^|[\s(])\*([^*\n]+)\*(?=[\s).,!?:;]|$)/g, '$1**$2**')
    .replace(/(^|[\s(])~([^~\n]+)~(?=[\s).,!?:;]|$)/g, '$1~~$2~~');
  return converted.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
}
