// Announcements from us, under the bell (design §13.3). The operator sends
// them; the page only lists them and marks them read.
import { api } from './api';

export interface Announcement {
  id: string;
  title: string;
  body: string;
  createdAt: string;
  read: boolean;
}

export function fetchAnnouncements(): Promise<{ announcements: Announcement[]; unread: number }> {
  return api('GET', '/api/announcements');
}

export function markAnnouncementsRead(): Promise<{ read: number }> {
  return api('POST', '/api/announcements/read', {});
}
