/**
 * Policy Decision 子域入口（DES-5.0）。
 * 热路径裁决 + Redis 判定缓存 + 默认拒绝。
 */
export { PolicyDecisionService, POLICY_DECISION_CACHE } from './policy-decision.service';
export type { PolicyDecisionCache } from './policy-decision.service';
export { PolicyDecisionModule } from './policy-decision.module';
