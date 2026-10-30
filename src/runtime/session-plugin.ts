/** OpenCode V1 chat.headers hook. Do not load this plugin into OpenCode V2. */
export default async function coagentSessionPlugin() {
  return {
    'chat.headers': async (input: { sessionID: string }, output: { headers: Record<string,string> }) => {
      output.headers['x-coagent-session'] = input.sessionID;
    },
  };
}
