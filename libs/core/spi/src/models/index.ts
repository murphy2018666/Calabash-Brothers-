/**
 * ModelGateway SPI —— LLM 模型网关
 *
 * 不变量（DES-13.9 安全交叉保证）：
 * - 双闸门不变：模型输出不直接触发工具调用，必须经内核拦截后再走 Policy
 * - Token 预算管控内置于此：所有模型通道必经 ModelGateway
 * - 三级降级策略（DES-8）：轻量模型降级 → 延后 → 拒绝
 * - 切换实现不改内核代码（FR-M7-08）
 */

export interface ModelInferenceRequest {
  agentId: string;
  runId: string;
  modelId: string;
  systemPrompt: string;
  userPrompt: string;
  maxTokens: number;
  temperature: number;
}

export interface ModelInferenceResult {
  content: string;
  inputTokens: number;
  outputTokens: number;
  modelId: string;
  degraded: boolean;
  /**
   * 是否为缓存降级响应（L2-5 引入，DES-8 三级降级 Tier 2 标记）。
   * - true 表示返回了缓存结果而非真实推理（不消耗 Token 预算）
   * - 缺省/undefined 表示走真实推理路径
   */
  cached?: boolean;
  traceSpanId: string;
}

export interface ModelBudget {
  agentId: string;
  runId: string;
  totalBudget: number;
  consumed: number;
  remaining: number;
}

export interface ModelGateway {
  /** 模型推理 —— 内核在调用后拦截输出再走 Policy */
  infer(req: ModelInferenceRequest): Promise<ModelInferenceResult>;

  /** 查询 Token 预算余量 */
  getBudget(agentId: string, runId: string): Promise<ModelBudget>;

  /** 健康检查 */
  healthy(): Promise<boolean>;
}
