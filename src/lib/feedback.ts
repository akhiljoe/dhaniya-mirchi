// "Send feedback" from the footer (design §12.8). Stored for the operator.
import { api } from './api';

export function sendFeedback(message: string, page: string): Promise<{ sent: boolean }> {
  return api('POST', '/api/feedback', { message, page });
}
