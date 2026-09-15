import { Test } from '@nestjs/testing';
import type { ToolCallRequest } from '@aegisci/shared/types';
import { InMemoryToolProvider } from '../providers/in-memory-tool-provider';

/**
 * SPI 契约测试 —— InMemoryToolProvider 实现 ToolProvider 接口正确性
 * （DES-13.9：工具只实现 execute()，前置链路 ACI→Policy→Vault→Sandbox 在内核，
 * 四步执行链不可跳过 —— Provider 自身不做任何授权判断）。
 */
describe('InMemoryToolProvider (ToolProvider SPI contract)', () => {
  let provider: InMemoryToolProvider;

  const req = (overrides: Partial<ToolCallRequest> = {}): ToolCallRequest => ({
    toolName: 'echo',
    action: 'echo',
    resource: 'repo/x',
    args: { message: 'hello' },
    agentId: 'agent-1',
    runId: 'run-1',
    ...overrides,
  });

  beforeEach(async () => {
    const moduleRef = await Test.createTestingModule({
      providers: [InMemoryToolProvider],
    }).compile();
    provider = moduleRef.get(InMemoryToolProvider);
  });

  it('exposes name = "echo"', () => {
    expect(provider.name).toBe('echo');
  });

  it('actions() lists supported actions', () => {
    expect(provider.actions()).toEqual(['echo']);
  });

  it('execute() echoes args and returns evidenceId + traceSpanId', async () => {
    const result = await provider.execute(req());
    expect(result.success).toBe(true);
    expect(result.evidenceId).toBeTruthy();
    expect(result.traceSpanId).toBeTruthy();
    const data = result.data as { echoed: Record<string, unknown>; action: string };
    expect(data.echoed).toEqual({ message: 'hello' });
    expect(data.action).toBe('echo');
  });

  it('execute() does not throw for unsupported action (kernel guards authorization)', async () => {
    // 不变量：Provider 只执行，不支持的动作由内核 ToolCallAuthorizeGuard 拦截，
    // Provider 契约层面保证 execute 不做策略判断。
    const result = await provider.execute(req({ action: 'unknown' }));
    expect(result.success).toBe(true);
  });

  it('healthy() returns true', async () => {
    expect(await provider.healthy()).toBe(true);
  });
});
