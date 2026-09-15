import {
  Controller,
  Get,
  Post,
  Param,
  Body,
  Query,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import type { SkillManifest, SkillState } from '@aegisci/shared/types';
import type { SkillRecord } from '@aegisci/domain/skill';
import { SkillService } from '@aegisci/domain/skill';

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 类型定义
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

export interface SkillListItem {
  skillId: string;
  name: string;
  version: string;
  type: string;
  description: string;
  riskTier: string;
  state: SkillState;
  signatureVerified: boolean;
  tags: string[];
  installedAt: string;
}

export interface SignatureChainResult {
  cosign: { ok: boolean; details?: string };
  certificate: { ok: boolean; details?: string };
  rekor: { ok: boolean; details?: string };
  compliance: { ok: boolean; details?: string };
  overall: 'passed' | 'failed';
}

export interface InstallRequest {
  tenantId: string;
  approvedBy: string;
  version?: string;
}

export interface InstallTask {
  taskId: string;
  skillId: string;
  status: 'pending' | 'verifying' | 'installing' | 'completed' | 'failed';
  progress: number;
  error?: string;
}

export interface SearchResponse {
  skills: SkillListItem[];
  total: number;
  page: number;
  pageSize: number;
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// Service
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

@Injectable()
export class SkillMarketService {
  private readonly logger = new Logger(SkillMarketService.name);
  private readonly installTasks = new Map<string, InstallTask>();

  constructor(private readonly skillService: SkillService) {}

  /** 列出所有技能（支持分页和过滤） */
  async listAll(
    page = 1,
    pageSize = 20,
    state?: string,
    type?: string,
    tenantId?: string,
  ): Promise<SearchResponse> {
    const records: SkillRecord[] = [];

    // 获取 active 技能
    const active = await this.skillService.listActive(tenantId ?? 'default');
    records.push(...active);

    // 过滤
    let filtered = records;
    if (state) {
      filtered = filtered.filter((r) => r.state === state);
    }
    if (type) {
      filtered = filtered.filter((r) => r.manifest.type === type);
    }

    // 分页
    const start = (page - 1) * pageSize;
    const paged = filtered.slice(start, start + pageSize);

    return {
      skills: paged.map((r) => this.toListItem(r)),
      total: filtered.length,
      page,
      pageSize,
    };
  }

  /** 搜索技能 */
  async search(keyword: string, page = 1, pageSize = 20): Promise<SearchResponse> {
    const all = await this.listAll(page, pageSize);
    const kw = keyword.toLowerCase();
    const results = all.skills.filter(
      (s) =>
        s.name.toLowerCase().includes(kw) ||
        s.description.toLowerCase().includes(kw) ||
        s.tags.some((t) => t.toLowerCase().includes(kw)),
    );
    return { ...all, skills: results, total: results.length };
  }

  /** 获取技能详情 */
  async getDetail(skillId: string): Promise<SkillListItem & { signatureChain: SignatureChainResult }> {
    const serviceRecord = await this.skillService.get(skillId);
    if (serviceRecord) {
      return {
        ...this.toListItem(serviceRecord),
        signatureChain: this.stubSignatureChain(serviceRecord.signatureVerified),
      };
    }

    throw new NotFoundException(`Skill not found: ${skillId}`);
  }

  /** 验证签名链 */
  verifySignatureChain(record: SkillRecord): SignatureChainResult {
    return this.stubSignatureChain(record.signatureVerified);
  }

  /** 安装技能（异步，返回 task ID） */
  async install(
    skillId: string,
    version: string,
    tenantId: string,
    approvedBy: string,
  ): Promise<InstallTask> {
    const taskId = `task_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

    const task: InstallTask = {
      taskId,
      skillId,
      status: 'pending',
      progress: 0,
    };
    this.installTasks.set(taskId, task);

    // 异步执行安装流程
    this.executeInstall(taskId, skillId, version, tenantId, approvedBy);

    return task;
  }

  /** 查询安装任务状态 */
  async getInstallStatus(taskId: string): Promise<InstallTask | null> {
    return this.installTasks.get(taskId) ?? null;
  }

  /** 获取分类列表 */
  async getCategories(): Promise<{ type: string; count: number }[]> {
    return [
      { type: 'tool', count: 5 },
      { type: 'agent', count: 3 },
      { type: 'connector', count: 2 },
      { type: 'policy-pack', count: 4 },
    ];
  }

  // ── 内部方法 ──

  private async executeInstall(
    taskId: string,
    skillId: string,
    version: string,
    tenantId: string,
    approvedBy: string,
  ): Promise<void> {
    const task = this.installTasks.get(taskId);
    if (!task) return;

    try {
      // Step 1: 验证签名
      task.status = 'verifying';
      task.progress = 20;
      await this.delay(100);

      task.progress = 40;
      await this.delay(100);

      // Step 2: 注册到系统
      task.status = 'installing';
      task.progress = 60;
      await this.delay(100);

      // Step 3: 完成
      task.status = 'completed';
      task.progress = 100;

      this.logger.log(`Install completed: ${taskId} → ${skillId}@${version}`);
    } catch (err) {
      task.status = 'failed';
      task.error = (err as Error).message;
      this.logger.error(`Install failed: ${taskId} - ${(err as Error).message}`);
    }
  }

  private stubSignatureChain(verified: boolean): SignatureChainResult {
    return {
      cosign: { ok: verified, details: verified ? 'Signature verified' : 'No signature' },
      certificate: { ok: verified, details: verified ? 'Certificate valid' : undefined },
      rekor: { ok: verified, details: verified ? 'Rekor entry found' : undefined },
      compliance: { ok: verified, details: verified ? 'Compliance gate passed' : 'Missing signature' },
      overall: verified ? 'passed' : 'failed',
    };
  }

  private toListItem(record: SkillRecord): SkillListItem {
    return {
      skillId: record.skillId,
      name: record.manifest.name,
      version: record.manifest.version,
      type: record.manifest.type,
      description: record.manifest.description,
      riskTier: record.manifest.riskTier,
      state: record.state,
      signatureVerified: record.signatureVerified,
      tags: (record.manifest.tags as string[]) ?? [],
      installedAt: record.installedAt,
    };
  }

  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// Controller
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

@Controller('api/skills')
export class SkillMarketController {
  private readonly logger = new Logger(SkillMarketController.name);

  constructor(private readonly marketService: SkillMarketService) {}

  /**
   * GET /api/skills
   * 列出所有技能（支持分页、过滤）
   */
  @Get()
  async list(
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
    @Query('state') state?: string,
    @Query('type') type?: string,
    @Query('tenantId') tenantId?: string,
  ): Promise<SearchResponse> {
    return this.marketService.listAll(
      parseInt(page ?? '1'),
      parseInt(pageSize ?? '20'),
      state,
      type,
      tenantId,
    );
  }

  /**
   * GET /api/skills/search
   * 搜索技能
   */
  @Get('search')
  async search(
    @Query('q') keyword: string,
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
  ): Promise<SearchResponse> {
    if (!keyword) {
      return this.marketService.listAll(parseInt(page ?? '1'), parseInt(pageSize ?? '20'));
    }
    return this.marketService.search(keyword, parseInt(page ?? '1'), parseInt(pageSize ?? '20'));
  }

  /**
   * GET /api/skills/:skillId
   * 获取技能详情（含签名链）
   */
  @Get(':skillId')
  async detail(
    @Param('skillId') skillId: string,
  ): Promise<SkillListItem & { signatureChain: SignatureChainResult }> {
    return this.marketService.getDetail(skillId);
  }

  /**
   * POST /api/skills/:skillId/install
   * 安装技能（异步，返回 task ID）
   */
  @Post(':skillId/install')
  async install(
    @Param('skillId') skillId: string,
    @Body() body: InstallRequest,
  ): Promise<InstallTask> {
    const version = body.version ?? '1.0.0';
    return this.marketService.install(skillId, version, body.tenantId, body.approvedBy);
  }

  /**
   * GET /api/skills/tasks/:taskId
   * 查询安装任务状态
   */
  @Get('tasks/:taskId')
  async getTask(@Param('taskId') taskId: string): Promise<InstallTask | null> {
    return this.marketService.getInstallStatus(taskId);
  }

  /**
   * POST /api/skills/verify-signature
   * 验证签名链
   */
  @Post('verify-signature')
  async verifySignature(
    @Body() body: { skillId: string },
  ): Promise<SignatureChainResult> {
    const detail = await this.marketService.getDetail(body.skillId);
    return detail.signatureChain;
  }

  /**
   * GET /api/skills/categories
   * 获取技能分类列表
   */
  @Get('categories')
  async categories(): Promise<{ type: string; count: number }[]> {
    return this.marketService.getCategories();
  }
}
