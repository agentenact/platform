import { apiCall } from '@/server/api';
import { createAgentActions } from '@/server/agent-actions';
import { createPauseRoute } from '@/server/pause-confirm';
import { accessToken } from '@/server/session';

// POST (the button) pauses; GET only goes back to the confirmation page. See server/pause-confirm.ts.
const actions = createAgentActions({ api: apiCall, token: accessToken });
const route = createPauseRoute({ token: accessToken, setPaused: (id, paused) => actions.setPaused(id, paused) });

export const dynamic = 'force-dynamic';
export const GET = route.GET;
export const POST = route.POST;
