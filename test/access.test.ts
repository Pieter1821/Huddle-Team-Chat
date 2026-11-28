import { describe, expect, it } from 'vitest';
import {
  canChangeRole,
  canDeactivate,
  canInvite,
  type Actor,
  type Role,
} from '../src/worker/modules/access/access';

const actor = (role: Role, userId = 'me'): Actor => ({
  userId,
  role,
  email: 'a@x.test',
  name: 'A',
  workspaceId: 'w',
});
const target = (role: Role, userId = 'them') => ({ userId, role });

describe('canInvite', () => {
  const off = { guests: false, members: false };
  const guestsOnly = { guests: true, members: false };
  const everyone = { guests: false, members: true };
  it.each<[Role, Role, string, { guests: boolean; members: boolean }, boolean]>([
    ['owner', 'admin', 'off', off, true],
    ['owner', 'guest', 'off', off, true],
    ['admin', 'admin', 'off', off, false],
    ['admin', 'admin', 'everyone', everyone, false],
    ['admin', 'member', 'off', off, true],
    ['member', 'member', 'off', off, false],
    ['member', 'member', 'guests only', guestsOnly, false],
    ['member', 'member', 'everyone', everyone, true],
    ['member', 'guest', 'off', off, false],
    ['member', 'guest', 'guests only', guestsOnly, true],
    ['member', 'guest', 'everyone', everyone, true],
    ['member', 'admin', 'everyone', everyone, false],
    ['member', 'owner', 'everyone', everyone, false],
    ['guest', 'guest', 'everyone', everyone, false],
    ['guest', 'member', 'everyone', everyone, false],
    ['owner', 'owner', 'off', off, false],
  ])('%s inviting a %s (members may invite: %s) → %s', (who, role, _label, policy, expected) => {
    expect(canInvite(actor(who), role, policy)).toBe(expected);
  });
});

describe('canChangeRole', () => {
  it('never lets anyone change their own role', () => {
    expect(canChangeRole(actor('owner'), target('owner', 'me'), 'member')).toBe(false);
  });
  it('never grants or removes ownership', () => {
    expect(canChangeRole(actor('owner'), target('member'), 'owner')).toBe(false);
    expect(canChangeRole(actor('owner'), target('owner'), 'admin')).toBe(false);
  });
  it('keeps admin rights in the owner’s hands', () => {
    expect(canChangeRole(actor('admin'), target('member'), 'admin')).toBe(false);
    expect(canChangeRole(actor('admin'), target('admin'), 'member')).toBe(false);
    expect(canChangeRole(actor('owner'), target('member'), 'admin')).toBe(true);
  });
  it('lets admins move people between member and guest', () => {
    expect(canChangeRole(actor('admin'), target('member'), 'guest')).toBe(true);
  });
  it('gives members and guests no say', () => {
    expect(canChangeRole(actor('member'), target('guest'), 'member')).toBe(false);
    expect(canChangeRole(actor('guest'), target('member'), 'guest')).toBe(false);
  });
});

describe('canDeactivate', () => {
  it('protects the owner and yourself', () => {
    expect(canDeactivate(actor('admin'), target('owner'))).toBe(false);
    expect(canDeactivate(actor('owner'), target('owner', 'me'))).toBe(false);
  });
  it('lets admins deactivate members and guests but not other admins', () => {
    expect(canDeactivate(actor('admin'), target('guest'))).toBe(true);
    expect(canDeactivate(actor('admin'), target('admin'))).toBe(false);
  });
});
