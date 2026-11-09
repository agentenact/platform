import { htmlResponse, magicLinkHtml } from '@/server/email-templates';

export function GET() {
  return htmlResponse(magicLinkHtml());
}
