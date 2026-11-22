// Mentions live in message text as tokens: <@USER_ID>, <@channel> (everyone in the conversation) and
// <@here> (everyone online). Storing the id rather than the name means renames never break them; the
// app shows the person's current name when it renders the token.

const TOKEN = /<@([0-9A-HJKMNP-TV-Z]{26}|channel|here)>/g;

export type ParsedMentions = { userIds: string[]; channel: boolean; here: boolean };

export function parseMentions(body: string): ParsedMentions {
  const userIds = new Set<string>();
  let channel = false;
  let here = false;
  for (const [, target] of body.matchAll(TOKEN)) {
    if (target === 'channel') channel = true;
    else if (target === 'here') here = true;
    else if (target) userIds.add(target);
  }
  return { userIds: [...userIds], channel, here };
}

export const mentionToken = (userId: string) => `<@${userId}>`;
