import { once } from 'node:events';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { createDemoHttpServer } from '../dist/server.js';

console.log('Household Brain: scripted MCP-client demonstration with fictional fixtures.');
console.log('No live Alexa integration, LLM, household service or external API is connected.');
const server = createDemoHttpServer();
const client = new Client({ name: 'synthetic-demo-client', version: '1' });
try {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${address.port}/mcp`)));
  const tools = await client.listTools();
  console.log(`Connected over Streamable HTTP. Available tools: ${tools.tools.map(t => t.name).join(', ')}.`);
  let previewToken;
  for (const [name, initialArgs] of [
    ['mealplan_get', {}],
    ['restock_for_meals', { days: 2, dry_run: true }],
    ['restock_for_meals', { days: 2, dry_run: false }],
    ['restock_for_meals', { days: 2, dry_run: true }],
    ['restock_for_meals', { days: 2, dry_run: false }],
    ['brief_get', { topics: ['household'] }],
    ['chore_log', { chore: 'recycling' }],
    ['brief_get', { topics: ['household'] }],
    ['household_summary', {}]
  ]) {
    const args = name === 'restock_for_meals' && initialArgs.dry_run === false
      ? { ...initialArgs, expected_token: previewToken } : initialArgs;
    const result = await client.callTool({ name, arguments: args });
    if (result.isError) throw new Error(`Demo tool ${name} failed`);
    if (name === 'restock_for_meals' && args.dry_run === true) previewToken = result.structuredContent?.previewToken;
    console.log(`\n${name} ${JSON.stringify(args)}`);
    for (const block of result.content) if (block.type === 'text') console.log(block.text);
    if (result.structuredContent) console.log(JSON.stringify(result.structuredContent, null, 2));
  }
} finally {
  await client.close();
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
}
