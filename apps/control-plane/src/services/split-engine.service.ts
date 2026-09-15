import { Injectable, Logger, BadRequestException } from '@nestjs/common';
import {
  type SplitModel,
  type SplitRecord,
  type Settlement,
  type SettlementStatus,
} from '@aegisci/shared/types';

/**
 * 分账引擎核心（K11）。
 *
 * 职责：
 * 1. 按分账比例计算技能所有者/平台方分账金额
 * 2. 存储分账模型（tenantId + skillId → SplitModel）
 * 3. 生成 SplitRecord 列表
 */
@Injectable()
export class SplitEngineService {
  private readonly logger = new Logger(SplitEngineService.name);

  /** tenantId/skillId → SplitModel */
  private readonly splitModelStore = new Map<string, Map<string, SplitModel>>();
  /** recordId → SplitRecord */
  private readonly splitRecordStore = new Map<string, SplitRecord>();

  // ── 默认分账模型 ──

  private static readonly DEFAULT_STANDARD: SplitModel = {
    ratio: 'standard',
    skillOwnerPct: 80,
    platformPct: 20,
  };

  private static readonly DEFAULT_CERTIFIED: SplitModel = {
    ratio: 'certified',
    skillOwnerPct: 90,
    platformPct: 10,
    certifiedAt: new Date().toISOString(),
  };

  // ── 公共接口 ──

  /** 计算分账金额，返回 SplitRecord */
  calculateSplit(
    billId: string,
    tenantId: string,
    skillId: string,
    revenue: number,
    model: SplitModel,
  ): SplitRecord {
    const skillOwnerAmount = parseFloat((revenue * model.skillOwnerPct / 100).toFixed(2));
    const platformAmount = parseFloat((revenue * model.platformPct / 100).toFixed(2));

    const record: SplitRecord = {
      recordId: `split_${billId}_${skillId}_${Date.now()}`,
      billId,
      tenantId,
      skillId,
      revenue,
      splitRatio: model.ratio,
      skillOwnerAmount,
      platformAmount,
      createdAt: new Date().toISOString(),
    };

    this.splitRecordStore.set(record.recordId, record);
    return record;
  }

  /** 查询租户的分账记录（支持按 billId 过滤） */
  getSplitRecords(tenantId: string, billId?: string): SplitRecord[] {
    return Array.from(this.splitRecordStore.values()).filter((r) => {
      if (r.tenantId !== tenantId) return false;
      if (billId && r.billId !== billId) return false;
      return true;
    });
  }

  /** 获取技能的分账模型 */
  getSplitModel(tenantId: string, skillId: string): SplitModel {
    const tenantModels = this.splitModelStore.get(tenantId) ?? new Map();
    return tenantModels.get(skillId) ?? SplitEngineService.DEFAULT_STANDARD;
  }

  /** 设置技能的分账模型 */
  setSplitModel(tenantId: string, skillId: string, model: SplitModel): void {
    const tenantModels = this.splitModelStore.get(tenantId) ?? new Map();
    tenantModels.set(skillId, model);
    this.splitModelStore.set(tenantId, tenantModels);
    this.logger.log(`split model set: ${tenantId}/${skillId} → ${model.ratio}`);
  }

  /** 获取所有分账模型的 key 列表（stub） */
  getAvailableRatios(): SplitRatio[] {
    return ['standard', 'certified'];
  }

  /** 清空存储（测试用） */
  clear(): void {
    this.splitRecordStore.clear();
    this.splitModelStore.clear();
  }
}

type SplitRatio = 'standard' | 'certified';
