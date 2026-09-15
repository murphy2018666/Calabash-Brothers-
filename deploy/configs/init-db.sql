-- Aegisci Control Plane — PostgreSQL 初始化脚本（兜底建库）
-- 实际表结构由应用运行时 ensureSchema() 自动创建

-- 启用 pg_stat_statements 扩展（可选，用于性能分析）
-- CREATE EXTENSION IF NOT EXISTS pg_stat_statements;

-- 应用运行时自动执行以下表的 ensureSchema：
--   revoked_jtis        — token 吊销记录（CREDENTIAL_JTI_REGISTRY）
--   agent_tokens        — agent token 注册表（AGENT_TOKEN_REGISTRY）
--   task_plans          — 任务计划（TASK_PLAN_REPOSITORY）
--   blackboard_sessions — 黑板会话（BLACKBOARD_REPOSITORY）
--   gates               — 门禁记录（GATE_REPOSITORY）
--   runs                — 流水线执行记录（RUN_REPOSITORY）
