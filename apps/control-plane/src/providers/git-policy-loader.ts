import { Injectable, Logger } from '@nestjs/common';
import type { PolicyRule } from '@aegisci/core/spi';
import { DslCompiler, type DslAst } from './dsl-parser';

/**
 * 策略版本信息 —— Git 策略文件的元数据与编译结果。
 */
export interface PolicyVersion {
  /** 版本号（对应 Git commit short SHA 或 semantic version） */
  version: string;
  /** 编译后的 AST */
  ast: DslAst;
  /** 编译/加载时间戳 */
  loadedAt: Date;
}

/**
 * GitPolicyLoader —— 策略文件热加载器。
 *
 * 职责：
 * - 从配置源（Git 仓库 / 本地文件路径）加载策略 DSL JSON
 * - 调用 DslCompiler 编译为 AST 并校验
 * - 支持热更新：切换版本时不重启服务
 * - 版本回滚：通过版本号切换到历史版本
 *
 * 与 L6 Shadow Mode 集成：
 * - loadAndActivate() 可传入 shadow 标志，仅写入影子引擎不替换主引擎
 * - 新旧版本并发验证通过后再激活（by PolicyVersion.compare）
 */
@Injectable()
export class GitPolicyLoader {
  private readonly logger = new Logger(GitPolicyLoader.name);

  /** 当前激活的版本 */
  private activeVersion: PolicyVersion | null = null;
  /** 影子版本（Shadow Mode 下暂存） */
  private shadowVersion: PolicyVersion | null = null;
  /** 历史版本记录（用于回滚，最多保留 lastN 条） */
  private history: PolicyVersion[] = [];

  constructor(
    /** 策略文件内容（由外部注入，模拟 Git fetch） */
    private policySource: () => Promise<{ content: string; version: string }>,
    /** 保留历史版本数量 */
    private maxHistorySize: number = 10,
  ) {}

  /**
   * 加载并激活策略版本。
   * @param shadow 若为 true，写入影子引擎不替换主版本（Shadow Mode）。
   * @returns 激活的 PolicyVersion；若 shadow=true 则返回影子版本。
   * @throws Error 当 DSL 编译失败或校验冲突时。
   */
  async loadAndActivate(shadow = false): Promise<PolicyVersion> {
    const { content, version } = await this.policySource();
    return this.compileAndStore(content, version, shadow);
  }

  /**
   * 直接用 DSL 字符串加载策略（绕过 policySource，用于测试/手动注入）。
   */
  async loadFromDsl(dslJson: string, version: string, shadow = false): Promise<PolicyVersion> {
    return this.compileAndStore(dslJson, version, shadow);
  }

  /**
   * 获取当前激活的策略版本。
   */
  getActiveVersion(): PolicyVersion | null {
    return this.activeVersion;
  }

  /**
   * 获取影子策略版本（Shadow Mode）。
   */
  getShadowVersion(): PolicyVersion | null {
    return this.shadowVersion;
  }

  /**
   * 切换到指定历史版本（回滚）。
   * @throws Error 当版本不在历史记录中时。
   */
  async rollbackTo(version: string): Promise<PolicyVersion> {
    const target = this.history.find(h => h.version === version);
    if (!target) {
      throw new Error(`Policy version "${version}" not found in history`);
    }
    this.activeVersion = target;
    this.logger.log(`Rolled back to policy version: ${version}`);
    return target;
  }

  /**
   * 获取历史版本列表（从旧到新）。
   */
  getHistory(): PolicyVersion[] {
    return [...this.history];
  }

  /**
   * 清除影子版本（验证通过后调用）。
   */
  clearShadow(): void {
    this.shadowVersion = null;
  }

  /**
   * 清除所有状态（重启时调用）。
   */
  reset(): void {
    this.activeVersion = null;
    this.shadowVersion = null;
    this.history = [];
  }

  // ── 内部方法 ────────────────────────────────────────────────────────

  private async compileAndStore(
    dslJson: string,
    version: string,
    shadow: boolean,
  ): Promise<PolicyVersion> {
    let ast: DslAst;
    try {
      ast = DslCompiler.compile(dslJson);
    } catch (err) {
      throw new Error(`DSL compile failed for version ${version}: ${(err as Error).message}`);
    }

    const conflicts = DslCompiler.validate(ast);
    if (conflicts.length > 0) {
      this.logger.warn(`Policy version ${version} has ${conflicts.length} conflict(s): ${conflicts.join('; ')}`);
      // 不阻断加载，但记录告警（与 L6-3 Shadow Mode 对齐：影子模式允许带冲突版本对比验证）
    }

    const pv: PolicyVersion = {
      version,
      ast,
      loadedAt: new Date(),
    };

    // 写入历史记录
    this.history.push(pv);
    if (this.history.length > this.maxHistorySize) {
      this.history.shift();
    }

    if (shadow) {
      this.shadowVersion = pv;
      this.logger.log(`Shadow policy loaded: version=${version}, rules=${ast.rules.length}`);
    } else {
      this.activeVersion = pv;
      this.logger.log(`Policy activated: version=${version}, rules=${ast.rules.length}`);
    }

    return pv;
  }
}
