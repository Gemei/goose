import { methods } from '@agentclientprotocol/sdk';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { getAcpClient } from './acpConnection';
import { envKeysToStore, probeMcpExtension, splitToolDescription } from './probeExtension';
import type { ExtensionFormData } from '../components/settings/extensions/utils';

vi.mock('./acpConnection', () => ({
  getAcpClient: vi.fn(),
}));

const form: ExtensionFormData = {
  name: 'AnyType',
  description: '',
  type: 'stdio',
  cmd: 'npx -y @anyproto/anytype-mcp',
  enabled: true,
  timeout: 300,
  envVars: [
    { key: 'OPENAPI_MCP_HEADERS', value: '••••••••', isEdited: false },
    { key: 'NEW_TOKEN', value: 'secret', isEdited: true },
  ],
  headers: [],
};

describe('splitToolDescription', () => {
  it('keeps a clean description and splits documented error responses', () => {
    expect(splitToolDescription('Search objects')).toEqual({
      summary: 'Search objects',
      errors: '',
    });
    expect(
      splitToolDescription(
        'Notion | Update a block Error Responses: 400: Bad request 404: Page not found'
      )
    ).toEqual({
      summary: 'Notion | Update a block',
      errors: 'Error Responses: 400: Bad request 404: Page not found',
    });
  });
});

describe('envKeysToStore', () => {
  it('skips masked secrets and keeps newly typed values', () => {
    expect(envKeysToStore(form)).toEqual([{ key: 'NEW_TOKEN', value: 'secret', isEdited: true }]);
  });
});

describe('probeMcpExtension', () => {
  const request = vi.fn();
  const sessionExtensionsAdd = vi.fn();
  const sessionExtensionsRemove = vi.fn();
  const toolsList = vi.fn();

  beforeEach(() => {
    request.mockReset();
    sessionExtensionsAdd.mockReset().mockResolvedValue(undefined);
    sessionExtensionsRemove.mockReset().mockResolvedValue(undefined);
    toolsList.mockReset();
    window.electron.getHomeDir = vi.fn().mockResolvedValue('C:\\Users\\mutecity');
    request.mockImplementation((method: string) => {
      if (method === methods.agent.session.new) return Promise.resolve({ sessionId: 'probe-1' });
      return Promise.resolve({});
    });
    toolsList.mockResolvedValue({
      tools: [{ name: 'anytype__search', description: 'Search objects', parameters: [] }],
    });
    vi.mocked(getAcpClient).mockResolvedValue({
      connection: { agent: { request } },
      goose: {
        sessionExtensionsAdd_unstable: sessionExtensionsAdd,
        sessionExtensionsRemove_unstable: sessionExtensionsRemove,
        toolsList_unstable: toolsList,
      },
    } as never);
  });

  it('lists tools from a hidden session and then removes it', async () => {
    await expect(probeMcpExtension(form)).resolves.toEqual([
      { name: 'anytype__search', description: 'Search objects' },
    ]);

    expect(request).toHaveBeenCalledWith(methods.agent.session.new, {
      cwd: 'C:\\Users\\mutecity',
      mcpServers: [],
      _meta: { hidden: true, client: 'goose-desktop', enabledExtensions: [] },
    });
    expect(sessionExtensionsAdd).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: 'probe-1',
        extension: expect.objectContaining({
          type: 'mcp',
          envKeys: ['OPENAPI_MCP_HEADERS', 'NEW_TOKEN'],
        }),
      })
    );
    expect(toolsList).toHaveBeenCalledWith({ sessionId: 'probe-1', extensionName: 'AnyType' });
    expect(sessionExtensionsRemove).toHaveBeenCalledWith({
      sessionId: 'probe-1',
      extensionKey: 'anytype',
    });
    expect(request).toHaveBeenCalledWith(methods.agent.session.delete, { sessionId: 'probe-1' });
  });
});
