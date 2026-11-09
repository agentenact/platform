import { confirmSignupHtml, htmlResponse } from '@/server/email-templates';

export function GET() {
  return htmlResponse(confirmSignupHtml());
}
