// The demo team the capture script seeds: Northwind Studio, a 9-person design and engineering
// studio getting its booking app's beta out the door. Every person, project and message is invented.
//
// Message text uses Huddle's own format (**bold**, `code`, ```blocks```), plus `@{key}` for a
// mention of a person by their key below (turned into <@userId> when seeding). Times are local
// "HH:MM" on the capture day; the script backdates each message to that time.

export const WORKSPACE = 'Northwind Studio';
export const DOMAIN = 'northwind.studio';

/** The owner first, then everyone else in the order they are invited. */
export const PEOPLE = [
  { key: 'maya', name: 'Maya Okafor', role: 'owner' }, // founder and design director (the viewer)
  { key: 'tomas', name: 'Tomás Reyes', role: 'admin' }, // engineering lead
  { key: 'priya', name: 'Priya Raman', role: 'member' }, // product designer
  { key: 'jonas', name: 'Jonas Lindqvist', role: 'member' }, // backend engineer
  { key: 'aiko', name: 'Aiko Tanaka', role: 'member' }, // frontend engineer
  { key: 'samuel', name: 'Samuel Mensah', role: 'member' }, // project manager
  { key: 'leila', name: 'Leila Haddad', role: 'member' }, // brand designer
  { key: 'elena', name: 'Elena Petrova', role: 'member' }, // QA engineer
  { key: 'ruth', name: 'Ruth Abebe', role: 'admin' }, // operations and finance
].map((p) => ({ ...p, email: `${p.key}@${DOMAIN}` }));

const everyone = PEOPLE.map((p) => p.key);

/** Channels to create (#general exists after setup; its topic is updated). */
export const CHANNELS = [
  { name: 'general', kind: 'public', topic: 'Announcements and everyday chat for everyone', members: everyone },
  {
    name: 'design',
    kind: 'public',
    topic: 'Critique, work in progress and the design system',
    members: ['maya', 'priya', 'leila', 'aiko', 'tomas', 'samuel'],
  },
  {
    name: 'engineering',
    kind: 'public',
    topic: 'Builds, reviews and how we ship',
    members: ['maya', 'tomas', 'jonas', 'aiko', 'elena', 'samuel'],
  },
  {
    name: 'launch-q1',
    kind: 'public',
    topic: 'Booking v2 beta: Monday, 40 customers',
    members: everyone,
  },
  { name: 'random', kind: 'public', topic: 'Lunch plans, pets and everything else', members: everyone },
  {
    name: 'leadership',
    kind: 'private',
    topic: 'Hiring, budget and planning',
    members: ['maya', 'tomas', 'samuel', 'ruth'],
  },
];

/** The CI webhook that posts build results into #engineering. */
export const WEBHOOK = { channel: 'engineering', name: 'Deploy bot' };

/**
 * Conversations and their messages, oldest first. `dm` lists the people in a direct message.
 * A message may carry reactions ({ emoji: [keys] }), thread replies, a file key, or come from the
 * webhook (by: 'bot').
 */
export const CONVERSATIONS = [
  {
    channel: 'general',
    messages: [
      {
        at: '09:02',
        by: 'samuel',
        text: 'Morning all ☀️ Studio sync moves to 11:30 today because of the client call. Same room, same snacks.',
        reactions: { '👍': ['maya', 'aiko', 'jonas', 'ruth'] },
      },
      {
        at: '09:15',
        by: 'ruth',
        text: 'November expenses are due Friday. If you bought anything for the offsite, drop the receipt in the shared folder and ping me.',
      },
      {
        at: '09:16',
        by: 'ruth',
        text: '(Yes Jonas, the label printer counts 🙂)',
        reactions: { '😂': ['jonas', 'leila', 'tomas'] },
      },
      {
        at: '11:58',
        by: 'maya',
        text: 'Quick recap from sync:\n• Booking v2 beta goes to the first 40 customers on **Monday**\n• @{elena} owns the release checklist, so please keep #launch-q1 up to date\n• Friday lunch is on the studio. @{ruth} is ordering from the Lebanese place again',
        reactions: { '🎉': ['samuel', 'priya', 'aiko', 'jonas', 'elena'], '❤️': ['leila', 'ruth'] },
        replies: [
          { at: '12:03', by: 'leila', text: 'Can we get the halloumi wraps again 🙏' },
          { at: '12:10', by: 'ruth', text: 'Already on the list.' },
        ],
      },
      {
        at: '14:20',
        by: 'leila',
        text: 'Studio photos from Tuesday are in the drive. A few are actually good (no thanks to Tomás blinking in every single one)',
        reactions: { '😂': ['priya', 'samuel', 'aiko'] },
      },
      { at: '14:22', by: 'tomas', text: 'I was mid-sentence. It’s called authenticity.' },
    ],
  },
  {
    channel: 'design',
    messages: [
      {
        at: '09:40',
        by: 'priya',
        text: 'Booking flow v3 is ready for a look 👋 Main change: date and time are now **one step** instead of two, and the confirmation screen shows the cancellation policy up front.',
        file: 'booking',
        reactions: { '👀': ['maya', 'leila'], '🔥': ['aiko'] },
        replies: [
          {
            at: '09:52',
            by: 'maya',
            text: 'Much calmer. The combined step works. Can the time slots wrap to 3 columns on small phones? At 320px they’re getting tight.',
          },
          {
            at: '10:05',
            by: 'priya',
            text: 'Good call. I’ll try 3 columns with a 44px minimum height so they stay easy to tap.',
          },
          {
            at: '10:07',
            by: 'aiko',
            text: 'If the slot component stays the same I can ship that today, it’s a one-line grid change on my side.',
          },
          {
            at: '10:31',
            by: 'leila',
            text: 'Love that the policy is visible now. Could the deposit line use the muted text style? It’s competing with the total.',
          },
          {
            at: '10:40',
            by: 'priya',
            text: 'Both changes are in the “Confirm / v3.1” frame @{maya}',
            reactions: { '🙌': ['maya', 'leila'] },
          },
        ],
      },
      {
        at: '10:12',
        by: 'leila',
        text: 'New icon set is in the library: 48 icons, 1.5px stroke, all on a 24px grid. The old ones are archived, not deleted, in case anything still points at them.',
        reactions: { '✅': ['priya', 'aiko'], '❤️': ['maya'] },
      },
      {
        at: '13:05',
        by: 'aiko',
        text: 'Small one: the focus ring on secondary buttons disappears on the cream background. Could we bump it to the accent colour at 2px?',
      },
      {
        at: '13:12',
        by: 'priya',
        text: 'Yes, that’s on me. Fixing it in the tokens now: `focus-ring: 2px solid var(--accent)`',
        reactions: { '🙏': ['aiko'] },
      },
      {
        at: '15:30',
        by: 'maya',
        text: 'Crit tomorrow at 4: booking v3.1 and the empty states. Bring the rough stuff too, rough is welcome.',
        reactions: { '👍': ['priya', 'leila', 'aiko'] },
      },
    ],
  },
  {
    channel: 'engineering',
    messages: [
      { at: '09:20', by: 'bot', text: '✅ booking-web main → staging (build 1482) passed in 3m 41s' },
      {
        at: '09:31',
        by: 'jonas',
        text: 'Heads up: I’m moving the availability query to the new index this morning. Expect a short latency spike on staging around 10.',
      },
      { at: '09:33', by: 'tomas', text: '👍 Can you post the before and after numbers when it’s done?' },
      {
        at: '10:26',
        by: 'jonas',
        text: 'Done. p95 for `GET /availability` went from 412ms to 38ms on staging. The index, for the curious:\n```\nCREATE INDEX slot_by_staff_day\n  ON slot (staff_id, day, starts_at)\n  WHERE cancelled_at IS NULL;\n```',
        reactions: { '🚀': ['tomas', 'aiko', 'elena'], '🤯': ['samuel'] },
        replies: [
          { at: '10:30', by: 'tomas', text: 'That’s a 10x. Nice work.' },
          { at: '10:44', by: 'elena', text: 'Running the regression suite against it now.' },
          { at: '11:20', by: 'elena', text: 'All 214 tests green ✅' },
        ],
      },
      {
        at: '11:48',
        by: 'aiko',
        text: 'PR #318 is up: the 3-column time slots from Priya’s v3. Small diff, screenshots in the description. @{tomas} could you review when you get a minute?',
      },
      { at: '12:15', by: 'tomas', text: 'Approved with one nit about the breakpoint name. Ship it.' },
      { at: '12:22', by: 'bot', text: '✅ booking-web main → staging (build 1489) passed in 3m 52s' },
      {
        at: '14:05',
        by: 'elena',
        text: 'Found one: on Safari 17 the date picker jumps back to today after you pick a time. Repro steps are in the ticket. Not a blocker for the beta, but I’d like it fixed before Monday.',
      },
      {
        at: '14:09',
        by: 'aiko',
        text: 'On it. I think it’s the controlled input resetting on re-render.',
        reactions: { '🙏': ['elena'] },
        readMarker: true,
      },
      {
        at: '15:12',
        by: 'tomas',
        text: '@{maya} the staging build with today’s fixes is ready whenever you want to click through it.',
      },
      { at: '15:14', by: 'bot', text: '✅ booking-web main → staging (build 1494) passed in 3m 38s' },
    ],
  },
  {
    channel: 'launch-q1',
    messages: [
      {
        at: '09:50',
        by: 'samuel',
        text: 'Launch checklist, Wednesday:\n✅ Beta list confirmed (40 studios)\n✅ Pricing page copy approved\n⏳ Help centre articles (3 of 5)\n⏳ Safari date picker fix\n⬜ Go/no-go call, Friday 2pm',
        reactions: { '👀': ['maya', 'elena'] },
      },
      {
        at: '10:15',
        by: 'elena',
        text: 'I’ll own the go/no-go checklist. The draft is in the doc, comments welcome.',
      },
      { at: '11:02', by: 'samuel', text: 'The launch plan as a PDF, for anyone who prefers paper', file: 'plan' },
      {
        at: '13:40',
        by: 'leila',
        text: 'The announcement email header is done, light and dark versions. @{samuel} want to see them before they go to Ruth for the send list?',
      },
      { at: '13:52', by: 'samuel', text: 'Yes please, send them over in a DM 🙏', readMarker: true },
      {
        at: '15:40',
        by: 'ruth',
        text: 'Send list is cleaned up: 40 beta customers, all opted in, 2 bounced addresses removed.',
      },
      {
        at: '15:46',
        by: 'elena',
        text: 'Help centre is at 4 of 5. The last one (rescheduling) goes up tomorrow morning.',
      },
    ],
  },
  {
    channel: 'random',
    messages: [
      {
        at: '10:02',
        by: 'jonas',
        text: 'Who put the empty oat milk carton back in the fridge. I just want to talk.',
        reactions: { '😂': ['aiko', 'leila', 'samuel', 'maya'], '🕵️': ['ruth'] },
      },
      { at: '10:04', by: 'aiko', text: 'It was like that when I got here 👀' },
      { at: '12:30', by: 'leila', text: 'Lunch walk to the river in 10 if anyone’s in' },
      { at: '12:31', by: 'priya', text: 'In! Grabbing my jacket' },
      {
        at: '14:48',
        by: 'samuel',
        text: 'Pet tax: Biscuit has found the radiator and will not be moving until spring',
        reactions: { '🥹': ['priya', 'leila', 'ruth', 'elena'], '❤️': ['maya', 'aiko'] },
      },
    ],
  },
  {
    channel: 'leadership',
    messages: [
      {
        at: '09:10',
        by: 'ruth',
        text: 'Q1 budget is in the sheet. We’re on track: contractor spend is 8% under because the design system work moved in-house.',
      },
      {
        at: '09:25',
        by: 'maya',
        text: 'Great. Let’s put some of that toward the second frontend hire. @{tomas} could you draft the role by Friday?',
      },
      {
        at: '09:41',
        by: 'tomas',
        text: 'Yes. Thinking mid-level, strong on accessibility and testing. Draft by Thursday.',
        reactions: { '👍': ['maya', 'samuel'] },
      },
      {
        at: '15:20',
        by: 'samuel',
        text: 'Two candidates from the referral list can come in next week. Tuesday or Wednesday afternoon works for both.',
      },
      { at: '15:22', by: 'maya', text: 'Wednesday. I’ll book the small room.' },
    ],
  },
  {
    dm: ['maya', 'priya'],
    messages: [
      {
        at: '11:10',
        by: 'priya',
        text: 'Thanks for the notes on v3 this morning! Is it okay if I take Friday afternoon off? Dentist.',
      },
      { at: '11:14', by: 'maya', text: 'Of course. Enjoy the dentist (said no one ever).' },
      { at: '11:15', by: 'priya', text: '😂 thank you!' },
    ],
  },
  {
    dm: ['maya', 'aiko', 'leila'],
    messages: [
      {
        at: '13:20',
        by: 'leila',
        text: 'Planning a small surprise for Samuel’s 5 years at the studio on Monday. Cake and a card, ideas welcome',
      },
      { at: '13:24', by: 'aiko', text: 'I can draw the card!' },
      { at: '13:30', by: 'maya', text: 'Love it. Put the cake on the studio card.', reactions: { '🎂': ['leila', 'aiko'] } },
    ],
  },
  {
    dm: ['maya', 'tomas'],
    messages: [
      {
        at: '14:30',
        by: 'tomas',
        text: 'Got 10 minutes before crit tomorrow? I’d like to run the hiring plan by you before it goes to the group.',
      },
      { at: '14:41', by: 'maya', text: 'Sure, 3:30?', readMarker: true },
      { at: '15:35', by: 'tomas', text: 'Perfect. Also: the Safari fix is on staging 🎉' },
    ],
  },
  {
    dm: ['leila', 'samuel'],
    messages: [
      {
        at: '13:58',
        by: 'leila',
        text: 'Here are the email headers. Dark one on top, light below. The type is a touch bigger than the website hero on purpose, it reads better at inbox size.',
      },
      { at: '14:06', by: 'samuel', text: 'These are great. Going with the dark one, it matches the app screenshots.' },
      { at: '14:07', by: 'leila', text: '🙌 sending to Ruth now', reactions: { '👍': ['samuel'] } },
    ],
  },
];

/**
 * Which conversations stay unread for Maya when the capture starts, so the sidebar shows unread
 * channels and a mention badge. Everything else is marked read. For these, Maya has read up to the
 * message marked `readMarker`.
 */
export const LEFT_UNREAD = ['launch-q1', 'engineering', 'dm:maya,tomas'];

/** A pending invitation that shows in Admin › People. */
export const PENDING_INVITE = { email: `noor@${DOMAIN}`, role: 'member' };
