import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createWorkspaceServer} from './index.mjs';
import {attachGuestMeetings} from './guest-meetings.mjs';

export async function createWorkspaceWithMeetings(options = {}) {
  const workspace = await createWorkspaceServer(options);
  let guest;
  try {guest = attachGuestMeetings(workspace.server, {...options.guest, origin: () => workspace.origin});}
  catch (error) {await workspace.close(); throw error;}
  return {server: workspace.server, get origin() {return workspace.origin;},
    async close() {guest.close(); await workspace.close();}};
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const app = await createWorkspaceWithMeetings();
  app.server.listen(Number(process.env.PORT || 4173), process.env.HOST || '0.0.0.0', () =>
    console.log(`Veyra Workspace: ${app.origin}\nGuest meetings: ${app.origin}/meet.html (enabled unless GUEST_MEETINGS_ENABLED=false)`));
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => {
    app.close().then(() => process.exit(0)); setTimeout(() => process.exit(0), 3000).unref();
  });
}
