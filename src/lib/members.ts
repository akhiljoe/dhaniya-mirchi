// The browser side of household members (design §19): who is in the
// household, who is invited, and joining one. Every check happens in the api;
// this only calls it and words the results.
import { api } from './api';

export interface MemberApp {
  vendor: string;
  status: string; // 'active' | 'needs_reconnect' | 'error'
}

export interface Member {
  userId: string;
  email: string | null;
  name: string | null; // what the pages call them; null until Google or they say
  role: 'owner' | 'member';
  you: boolean;
  joinedAt: string;
  apps: MemberApp[];
}

export interface SentInvite {
  id: string;
  email: string;
  createdAt: string;
  expiresAt: string;
}

// An invite waiting for the signed-in user (from /api/me).
export interface PendingInvite {
  id: string;
  householdName: string;
  invitedBy: string | null;
  members: number;
}

export function fetchMembers(): Promise<{ members: Member[]; invites: SentInvite[] }> {
  return api('GET', '/api/household/members');
}

export function sendInvite(email: string): Promise<{ invite: SentInvite }> {
  return api('POST', '/api/household/invites', { email });
}

export function cancelInvite(id: string): Promise<unknown> {
  return api('POST', `/api/household/invites/${encodeURIComponent(id)}/cancel`, {});
}

export function removeMember(userId: string): Promise<unknown> {
  return api('POST', `/api/household/members/${encodeURIComponent(userId)}/remove`, {});
}

export function leaveHousehold(): Promise<unknown> {
  return api('POST', '/api/household/leave', {});
}

export function acceptInvite(id: string): Promise<unknown> {
  return api('POST', `/api/invites/${encodeURIComponent(id)}/accept`, {});
}

export function declineInvite(id: string): Promise<unknown> {
  return api('POST', `/api/invites/${encodeURIComponent(id)}/decline`, {});
}

// What to call a person. Their name when there is one; otherwise the email's
// local part, which is what every page used to show ("owner",
// "member's") and what nobody calls anybody.
export function memberName(email: string | null, you = false, name: string | null = null): string {
  if (you) return 'You';
  if (name) return name;
  if (!email) return 'A member';
  return email.split('@')[0];
}

// Set from the Household page. The api keeps it to one line and 40 chars.
export function renameMe(name: string): Promise<{ name: string }> {
  return api('POST', '/api/me/name', { name });
}

// "Alex invited you to Home" — who, when there is someone to name.
export function inviteLine(i: PendingInvite): string {
  return i.invitedBy ? `${memberName(i.invitedBy)} invited you to join ${i.householdName}` : `You're invited to join ${i.householdName}`;
}
