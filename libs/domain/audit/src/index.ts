/**
 * Audit 子域入口（DES-8）。
 * WORM 追加写，无更新/删除；内核组件不可关闭。
 */
export { AuditWormService, AUDIT_WORM_SINK } from './audit-worm.service';
export type { AuditWormSink, AuditSealedResult } from './audit-worm.service';
export { AuditModule } from './audit.module';
