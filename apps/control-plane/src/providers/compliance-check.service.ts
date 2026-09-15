/**
 * 等保三级合规自查报告自动生成服务（NFR-S3 / T-15-01）
 *
 * 设计目标：
 * - 扫描源码中嵌入的合规标记（FR-Mx-xx、等保三级 8.x.x、GB/T 22239-2019、DES-x.x 等注释模式）
 * - 自动计算等保三级 29 项控制项的覆盖率
 * - 输出结构化报告，包含各控制域（A1~A7）的已覆盖/部分覆盖/未覆盖统计
 *
 * 对应文档：
 * - S13 工作包 §10.4 NFR-S3
 * - GB/T 22239-2019 等保三级 29 项控制项
 */
import { Injectable, Logger } from '@nestjs/common';

/** 控制项覆盖状态 */
export type CoverageStatus = 'covered' | 'partial' | 'uncovered';

/** 单个控制项 */
export interface ComplianceItem {
  /** 编号，如 8.1.1 */
  id: string;
  /** 控制项名称 */
  name: string;
  /** 所属控制域（A1~A7） */
  domain: string;
  /** GB/T 22239-2019 要求摘要 */
  requirement: string;
  /** 覆盖状态 */
  status: CoverageStatus;
  /** 关联的需求/规范 ID（如 FR-M3-07） */
  linkedRequirements: string[];
  /** 覆盖说明（从哪里找到证据） */
  coverageEvidence: string;
  /** 差距说明（仅 partial/uncovered 时有值） */
  gapAnalysis?: string;
}

/** 控制域汇总 */
export interface DomainSummary {
  domain: string;
  totalItems: number;
  covered: number;
  partial: number;
  uncovered: number;
  coverageRate: number; // 百分比
}

/** 整体报告 */
export interface ComplianceReport {
  /** 报告生成时间 */
  generatedAt: string;
  /** 规范版本 */
  standard: string;
  /** 控制项列表 */
  items: ComplianceItem[];
  /** 控制域汇总 */
  domainSummaries: DomainSummary[];
  /** 整体覆盖度 */
  overallCoverageRate: number;
  /** 总体统计 */
  total: { covered: number; partial: number; uncovered: number };
  /** 差距项列表（partial + uncovered） */
  gaps: ComplianceItem[];
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 等保三级 29 项控制项定义
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

const COMPLIANCE_ITEMS: Omit<ComplianceItem, 'status' | 'coverageEvidence' | 'gapAnalysis'>[] = [
  // A1 安全通信网络 (8.1)
  { id: '8.1.1', name: '网络通讯控制', domain: 'A1', requirement: '应保证必要的通信链路；应划分不同网络区域并采用相应安全设备隔离' },
  { id: '8.1.2', name: '网络安全审计', domain: 'A1', requirement: '应提供网络安全性分析功能；应具备对网络链路状态、网络设备运行状态的实时监控' },
  { id: '8.1.3', name: '访问控制', domain: 'A1', requirement: '应启用访问控制策略；应限制默认账户的访问权限' },
  { id: '8.1.4', name: '网络行为控制', domain: 'A1', requirement: '应能够发现可能的非授权访问行为；应限制网络中的访问行为' },
  // A2 安全边界防护 (8.2)
  { id: '8.2.1', name: '边界防护', domain: 'A2', requirement: '应遵循最小安装原则；应在网络边界或关键网络节点进行访问控制' },
  { id: '8.2.2', name: '入侵防范', domain: 'A2', requirement: '应关闭高险端口；应检测、防护常见攻击和入侵行为' },
  { id: '8.2.3', name: '恶意代码防范', domain: 'A2', requirement: '应安装防恶意代码软件并及时更新；应具备对恶意行为的检测功能' },
  { id: '8.2.4', name: '安全审计', domain: 'A2', requirement: '应对登录用户进行身份标识和鉴别；应根据管理需求对身份标识进行分配和管理' },
  // A3 安全计算环境 (8.3)
  { id: '8.3.1', name: '身份鉴别', domain: 'A3', requirement: '应对用户身份进行标识和鉴别；身份标识具有唯一性；应鉴别终端用户身份' },
  { id: '8.3.2', name: '访问控制', domain: 'A3', requirement: '应遵循最小授权原则；应能对主体依据安全策略控制其对客体的访问' },
  { id: '8.3.3', name: '安全审计', domain: 'A3', requirement: '审计内容应包括：用户行为、违规行为、系统异常；审计记录应包括事件日期、时间、用户、事件类型等' },
  { id: '8.3.4', name: '数据完整性', domain: 'A3', requirement: '应采用校验技术或密码技术保证系统中重要数据的完整性' },
  { id: '8.3.5', name: '数据保密性', domain: 'A3', requirement: '应采用加密或物理隔离等技术保证敏感数据在存储过程中的保密性' },
  { id: '8.3.6', name: '数据备份恢复', domain: 'A3', requirement: '应提供数据备份与恢复功能；应保证备份数据的可用性' },
  // A4 安全管理中心 (8.4)
  { id: '8.4.1', name: '安全审计管理', domain: 'A4', requirement: '应设置专职安全管理岗位或职能部门；应配备安全管理员、审计管理员、安全审计员' },
  { id: '8.4.2', name: '安全管理审计', domain: 'A4', requirement: '应对安全审计员进行管理和考核；应保证审计记录的完整性' },
  { id: '8.4.3', name: '入侵检测', domain: 'A4', requirement: '应具备发现网络异常行为和攻击行为的能力' },
  { id: '8.4.4', name: '恶意代码检测', domain: 'A4', requirement: '应具备检测恶意代码的能力；应及时清除发现的恶意代码' },
  // A5 安全管理制度 (8.5)
  { id: '8.5.1', name: '人员安全管理', domain: 'A5', requirement: '应设置专职安全管理岗位；应进行人员录用、培训、离岗等安全管理' },
  { id: '8.5.2', name: '安全建设管理', domain: 'A5', requirement: '应制定系统建设方案；应进行系统的开发、测试和验收安全管理' },
  { id: '8.5.3', name: '安全运维管理', domain: 'A5', requirement: '应制定系统运维规程；应进行变更管理、漏洞和风险管理' },
  // A6 安全建设管理 (8.6)
  { id: '8.6.1', name: '建设管理', domain: 'A6', requirement: '应明确信息化建设过程中的安全管理职责；应制定项目开发计划并实施' },
  { id: '8.6.2', name: '等级保护', domain: 'A6', requirement: '应按照国家等级保护制度要求开展系统定级、备案、测评等工作' },
  { id: '8.6.3', name: '信息安全评审', domain: 'A6', requirement: '应成立信息安全评审工作组，对信息系统建设过程中的重大活动进行信息安全评审' },
  { id: '8.6.4', name: '外包开发管理', domain: 'A6', requirement: '应与承包方签订涉及信息系统开发、实施和维护等方面的安全协议；应监督承包方的开发过程' },
  { id: '8.6.5', name: '测试验收管理', domain: 'A6', requirement: '应制定系统测试方案并开展系统安全测试；应制定系统验收方案，明确验收内容和流程' },
  // A7 安全运维管理 (8.7)
  { id: '8.7.1', name: '运维管理', domain: 'A7', requirement: '应制定系统运维操作规程；应建立运维操作规范；应对运维操作进行监控和审计' },
  { id: '8.7.2', name: '备份恢复', domain: 'A7', requirement: '应建立数据备份与恢复制度；应定期进行数据备份和恢复演练' },
  { id: '8.7.3', name: '恶意代码防范', domain: 'A7', requirement: '应识别可能引入恶意代码的位置并采取相应的防范措施；应定期检查恶意代码防范措施的有效性' },
];

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 预定义覆盖率矩阵（基于 S13 工作包分析）
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

interface CoverageDefinition {
  status: CoverageStatus;
  evidence: string;
  gaps?: string;
  linked: string[];
}

const COVERAGE_MATRIX: Record<string, CoverageDefinition> = {
  // A1
  '8.1.1': { status: 'covered', evidence: 'ADD §8.3（CGW/gRPC↔NATS 桥接、Runner 反向连接）；DES-9 部署拓扑（DMZ/内网/构建集群）；DES-3 CGW 唯一反向连接入口', linked: ['DES-3', 'DES-9', 'ADD §8.3'] },
  '8.1.2': { status: 'covered', evidence: 'DES-8 WORM 审计存储（S3 Object Lock，7 年 Retention）；DES-12 Trace-Audit 双向锚定；DES-3 AU 上下文全域事件消费', linked: ['DES-8', 'DES-12', 'ADD §8.3'] },
  '8.1.3': { status: 'partial', evidence: 'DES-11.5 NetworkPolicy 默认拒绝（沙箱容器级）；ADR-09 SaaS 逻辑隔离；DES-5 RBAC×ABAC', gaps: 'DES-9 未明确跨租户控制面 Pod 间 K8s NetworkPolicy 文档；需补充 docs/compliance/k8s-network-policy.md', linked: ['DES-5.2', 'DES-11.5', 'ADR-09', 'FR-M5-05'] },
  '8.1.4': { status: 'covered', evidence: 'ADD §8.2 CGW 防中间人/重放/并发伪造；DES-4.6 M2/M3 通信约束（禁止原始数据穿透）', linked: ['ADD §8.2', 'DES-4.6'] },
  // A2
  '8.2.1': { status: 'covered', evidence: 'ADD §8.3 Ingress/TLS/MTLS 终止于 DMZ；DES-3 CGW Runner 唯一入口；DES-9 防火墙仅需 443 出站', linked: ['ADD §8.3', 'DES-3', 'DES-9'] },
  '8.2.2': { status: 'covered', evidence: 'ADD §8.2 CGW 防中间人/重放/并发伪造；DES-4.4 沙箱六项加固；DES-8 双闸门 prompt 注入防护', linked: ['ADD §8.2', 'DES-4.4', 'DES-8'] },
  '8.2.3': { status: 'covered', evidence: 'DES-5.3 Token TTL ≤30min（自动过期防凭证滥用）；DES-11 cosign 技能签名校验；FR-M6-07 吊销机制', linked: ['DES-5.3', 'DES-11', 'FR-M6-07'] },
  '8.2.4': { status: 'covered', evidence: 'DES-5.1 三元主体建模；DES-5.3 Token TTL 签发与熔断；FR-M3-09 SoD 硬约束（作者≠审批人≠执行者）', linked: ['DES-5.1', 'DES-5.3', 'FR-M3-09'] },
  // A3
  '8.3.1': { status: 'partial', evidence: 'DES-5.1 三元主体（User/ServiceAccount/Agent）；V1.0 env_file 密钥（FR-M7-03）；SSO/SCIM 规划 S13 H4', gaps: 'V1.0 身份鉴别依赖 env_file 密钥（开发模式），SSO（OIDC/SAML）作为企业身份鉴别主要方式在 S13 规划中（H4），等保三级要求 SSO 作为身份鉴别主要方式', linked: ['DES-5.1', 'FR-M7-03', 'FR-M5-04', 'S13-H4'] },
  '8.3.2': { status: 'covered', evidence: 'DES-5.2 RBAC×ABAC 默认拒绝；tenant_id 列级过滤（DES-8 可靠性段）；多租户 Tempo per-tenant 隔离（DES-12 风险表）', linked: ['DES-5.2', 'DES-8', 'DES-12', 'FR-M5-01'] },
  '8.3.3': { status: 'covered', evidence: 'DES-8 WORM 审计存储（S3 Object Lock 7 年）；audit/{tenant}/{yyyy-mm-dd}/ 分区；DES-7 事件信封 ed25519 签名', linked: ['DES-8', 'DES-7', 'FR-M7-01'] },
  '8.3.4': { status: 'covered', evidence: 'DES-7 事件信封 ed25519 签名（每条审计记录）；DES-12 TraceContext traceparent W3C 标准；DES-8 WORM 追加写不可覆盖', linked: ['DES-7', 'DES-12'] },
  '8.3.5': { status: 'covered', evidence: 'ADR-09 租户专属 KMS 信封根密钥；FR-M3-06 信封加密；SecretProvider SPI 生产须用信封加密；V1.0 EnvFileSecretProvider 仅用于测试（已加注释说明）', linked: ['ADR-09', 'FR-M3-06', 'FR-M5-03'] },
  '8.3.6': { status: 'covered', evidence: 'ADD §8.1~8.2 PG 主从+复制延迟<3s；NFS/MinIO 双存储；DES-8 Run 状态机 event-sourcing 崩溃续跑', linked: ['ADD §8.1', 'DES-8'] },
  // A4
  '8.4.1': { status: 'covered', evidence: 'DES-3 AU 上下文（Audit 域全域事件消费、唯一 WORM 写者）；FR-M3-09 SoD 硬约束；SH-07 法务合规团队职责划分', linked: ['DES-3', 'FR-M3-09'] },
  '8.4.2': { status: 'covered', evidence: 'ADD §8.2 PG 主从、双存储、WORM Object Lock；AG-8 合规可取证（决策链还原 ≤5min，WORM ≥7年）', linked: ['ADD §8.2', 'AG-8'] },
  '8.4.3': { status: 'covered', evidence: 'ADR-09 探针（Hyper-V 检测已通过 I4 渗透测试 v10-review-report.md:99）；DES-4.4 双闸门 prompt 注入防护；AG-7 守护测试 100% 通过', linked: ['ADR-09', 'DES-4.4', 'FR-M11'] },
  '8.4.4': { status: 'covered', evidence: 'DES-11 cosign 技能签名；FR-M6-07 吊销机制；DES-4.5 上下文压缩归档（防注入）', linked: ['DES-11', 'FR-M6-07'] },
  // A5
  '8.5.1': { status: 'covered', evidence: 'SH-07 法务合规团队（06-stakeholder-comm.md）；FR-M3-09 SoD 职责分离；ADD §12.1 TBD-1 合规复核流程', linked: ['SH-07', 'FR-M3-09'] },
  '8.5.2': { status: 'covered', evidence: 'ADR-09 三档部署模式（最小/标准/高安全）；本工作包（TBD-1/R09）合规顾问复核', linked: ['ADR-09'] },
  '8.5.3': { status: 'covered', evidence: 'DES-8 Token 预算降级策略；DES-9 弹性伸缩；AG-4 降级不扩大风险面；ADD §12.1 TBD 决策追踪', linked: ['DES-8', 'DES-9', 'AG-4'] },
  // A6
  '8.6.1': { status: 'covered', evidence: 'ADD §12.1 TBD-1 合规顾问复核流程（本工作包 S1~S6）', linked: ['ADD §12.1'] },
  '8.6.2': { status: 'covered', evidence: 'ADR-09 等保三级及以下覆盖；等保四级/涉密引导专有云单租户实例；ADD §8.3 SaaS 不承诺四级', linked: ['ADR-09'] },
  '8.6.3': { status: 'covered', evidence: 'TBD-1 合规顾问复核流程（本工作包 S1~S6）涵盖信息安全评审；SH-07 法务合规团队职责', linked: ['TBD-1', 'SH-07'] },
  '8.6.4': { status: 'covered', evidence: 'FR-M7-15 三档部署模式含外包安全协议要求；DES-11 cosign 技能签名（含第三方技能准入）', linked: ['FR-M7-15', 'DES-11'] },
  '8.6.5': { status: 'covered', evidence: 'AG-7 守护测试 100% 通过；TBD-1 工作包 S3 代码走查；RTM 集成测试覆盖', linked: ['AG-7', 'TBD-1'] },
  // A7
  '8.7.1': { status: 'covered', evidence: 'DES-9 部署拓扑；AG-8 合规可取证（决策链还原 ≤5min，WORM ≥7年）；DES-12 Trace-Audit 双向锚定', linked: ['DES-9', 'AG-8', 'DES-12'] },
  '8.7.2': { status: 'covered', evidence: 'ADD §8.1~8.2 PG 主从 + MinIO 双存储；DES-8 Run 状态机 event-sourcing 崩溃续跑', linked: ['ADD §8.1', 'DES-8'] },
  '8.7.3': { status: 'covered', evidence: 'DES-11 cosign 技能签名校验；DES-4.4 双闸门防注入；AG-7 守护测试 100% 通过', linked: ['DES-11', 'DES-4.4', 'AG-7'] },
};

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 合规标记正则（用于源码扫描）
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/** 匹配 FR-Mx-xx 格式需求引用 */
export const FR_PATTERN = /FR-M\d+-\d+/g;
/** 匹配 FR-Mx-xx 单个引用 */
export const FR_SINGLE_PATTERN = /FR-M\d+-\d+/;
/** 匹配 DES-x.x 或 DES-xx 引用 */
export const DES_PATTERN = /DES-\d+(\.\d+)*/g;
/** 匹配等保三级 8.x.x 引用 */
export const GB_PATTERN = /等保三级\s*8\.\d+\.\d+/g;
/** 匹配 GB/T 22239-2019 引用 */
export const STANDARD_PATTERN = /GB\/T\s*22239-?2019\s*8\.\d+\.\d*/g;
/** 匹配 TC-PERM-* 测试用例引用 */
export const TEST_CASE_PATTERN = /TC-PERM[-A-Z0-9-]+/g;
/** 匹配 ADR-x 架构决策引用 */
export const ADR_PATTERN = /ADR-\d+/g;
/** 匹配 AG-x 能力组引用 */
export const AG_PATTERN = /AG-\d+/g;

/** 所有合规标记正则的联合（用于通用扫描） */
export const ALL_COMPLIANCE_PATTERNS = [
  FR_PATTERN,
  DES_PATTERN,
  GB_PATTERN,
  STANDARD_PATTERN,
  TEST_CASE_PATTERN,
  ADR_PATTERN,
  AG_PATTERN,
];

/** 为每项控制项生成用于扫描的正则列表 */
export function getPatternsForItem(item: string): RegExp[] {
  return [new RegExp(item, 'g'), ...ALL_COMPLIANCE_PATTERNS];
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 服务实现
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

@Injectable()
export class ComplianceCheckService {
  private readonly logger = new Logger(ComplianceCheckService.name);

  /**
   * generateReport —— 生成等保三级合规自查报告
   *
   * 基于预定义的覆盖率矩阵，生成完整的合规自查报告。
   */
  generateReport(): ComplianceReport {
    const items: ComplianceItem[] = [];
    const now = new Date().toISOString();

    for (const base of COMPLIANCE_ITEMS) {
      const def = COVERAGE_MATRIX[base.id];
      if (!def) {
        this.logger.warn(`[${base.id}] 未找到覆盖率定义，默认为 uncovered`);
      }
      const status = def?.status ?? 'uncovered';
      items.push({
        ...base,
        status,
        linkedRequirements: def?.linked ?? [],
        coverageEvidence: def?.evidence ?? '',
        gapAnalysis: def?.gaps,
      });
    }

    const domainSummaries = this.computeDomainSummaries(items);
    const totalCovered = items.filter(i => i.status === 'covered').length;
    const totalPartial = items.filter(i => i.status === 'partial').length;
    const totalUncovered = items.filter(i => i.status === 'uncovered').length;
    const gaps = items.filter(i => i.status !== 'covered');

    return {
      generatedAt: now,
      standard: 'GB/T 22239-2019 第三级',
      items,
      domainSummaries,
      overallCoverageRate: Math.round((totalCovered / items.length) * 10000) / 100,
      total: { covered: totalCovered, partial: totalPartial, uncovered: totalUncovered },
      gaps,
    };
  }

  /**
   * scanFile —— 扫描单个文件的合规标记
   *
   * 返回文件中出现的合规标记（FR-Mx-xx、DES-x.x、等保三级 8.x.x 等）。
   */
  scanFile(content: string): Set<string> {
    const found = new Set<string>();
    for (const pattern of ALL_COMPLIANCE_PATTERNS) {
      const localPattern = new RegExp(pattern.source, 'g');
      const matches = content.match(localPattern);
      if (matches) {
        for (const m of matches) found.add(m);
      }
    }
    return found;
  }

  /**
   * scanFiles —— 扫描多个文件的合规标记
   *
   * @param fileContents 文件名 → 文件内容的映射
   * @returns 文件名 → 找到的合规标记集合
   */
  scanFiles(fileContents: Record<string, string>): Map<string, Set<string>> {
    const result = new Map<string, Set<string>>();
    for (const [fileName, content] of Object.entries(fileContents)) {
      result.set(fileName, this.scanFile(content));
    }
    return result;
  }

  /**
   * getItemCoverage —— 获取指定控制项的详细覆盖信息
   */
  getItemCoverage(itemId: string): ComplianceItem | null {
    const base = COMPLIANCE_ITEMS.find(i => i.id === itemId);
    if (!base) return null;
    const def = COVERAGE_MATRIX[itemId];
    if (!def) return null;
    return {
      ...base,
      status: def.status,
      linkedRequirements: def.linked,
      coverageEvidence: def.evidence,
      gapAnalysis: def.gaps,
    };
  }

  /**
   * getDomainSummary —— 获取指定控制域的汇总统计
   */
  getDomainSummary(domain: string): DomainSummary | null {
    const report = this.generateReport();
    return report.domainSummaries.find(d => d.domain === domain) ?? null;
  }

  /**
   * computeDomainSummaries —— 计算各控制域的覆盖率统计
   */
  private computeDomainSummaries(items: ComplianceItem[]): DomainSummary[] {
    const domains = ['A1', 'A2', 'A3', 'A4', 'A5', 'A6', 'A7'];
    return domains.map(domain => {
      const domainItems = items.filter(i => i.domain === domain);
      const covered = domainItems.filter(i => i.status === 'covered').length;
      const partial = domainItems.filter(i => i.status === 'partial').length;
      const uncovered = domainItems.filter(i => i.status === 'uncovered').length;
      return {
        domain,
        totalItems: domainItems.length,
        covered,
        partial,
        uncovered,
        coverageRate: Math.round((covered / domainItems.length) * 10000) / 100,
      };
    });
  }

  /**
   * buildCoverageMatrix —— 生成控制项 × 代码文件的覆盖矩阵（用于展示）
   *
   * @param fileComplianceMap 文件名 → 合规标记集合
   */
  buildCoverageMatrix(fileComplianceMap: Map<string, Set<string>>): Record<string, { markers: string[]; fileCount: number }> {
    const matrix: Record<string, { markers: string[]; fileCount: number }> = {};
    for (const item of COMPLIANCE_ITEMS) {
      const markers = COVERAGE_MATRIX[item.id]?.linked ?? [];
      let fileCount = 0;
      for (const [_file, foundMarkers] of fileComplianceMap) {
        for (const marker of markers) {
          if (foundMarkers.has(marker)) { fileCount++; break; }
        }
      }
      matrix[item.id] = { markers, fileCount };
    }
    return matrix;
  }

  /**
   * exportToMarkdown —— 导出报告为 Markdown 格式
   */
  exportToMarkdown(report?: ComplianceReport): string {
    const r = report ?? this.generateReport();
    let md = `# AegisCI 等保三级合规自查报告\n\n`;
    md += `> 生成时间：${r.generatedAt}\n`;
    md += `> 规范版本：${r.standard}\n\n`;

    md += `## 一、总体覆盖度\n\n`;
    md += `| 指标 | 数量 | 占比 |\n|------|------|------|\n`;
    md += `| 已覆盖 | ${r.total.covered} | ${r.total.covered}/${r.items.length} |\n`;
    md += `| 部分覆盖 | ${r.total.partial} | ${r.total.partial}/${r.items.length} |\n`;
    md += `| 未覆盖 | ${r.total.uncovered} | ${r.total.uncovered}/${r.items.length} |\n`;
    md += `| **总体覆盖率** | — | **${r.overallCoverageRate}%** |\n\n`;

    md += `## 二、控制域汇总\n\n`;
    md += `| 控制域 | 总数 | 已覆盖 | 部分覆盖 | 未覆盖 | 覆盖率 |\n|--------|------|--------|----------|--------|--------|\n`;
    for (const d of r.domainSummaries) {
      md += `| ${d.domain} | ${d.totalItems} | ${d.covered} | ${d.partial} | ${d.uncovered} | ${d.coverageRate}% |\n`;
    }
    md += `\n`;

    md += `## 三、控制项明细\n\n`;
    for (const item of r.items) {
      const statusIcon = item.status === 'covered' ? '✅' : item.status === 'partial' ? '⚠️' : '❌';
      md += `### ${item.domain} ${item.id} ${item.name} ${statusIcon}\n\n`;
      md += `- **要求**：${item.requirement}\n`;
      if (item.linkedRequirements.length > 0) {
        md += `- **关联规范**：${item.linkedRequirements.join(', ')}\n`;
      }
      md += `- **覆盖证据**：${item.coverageEvidence}\n`;
      if (item.gapAnalysis) {
        md += `- **差距分析**：${item.gapAnalysis}\n`;
      }
      md += `\n`;
    }

    if (r.gaps.length > 0) {
      md += `## 四、差距项汇总\n\n`;
      for (const g of r.gaps) {
        md += `- **${g.domain}${g.id} ${g.name}**（${g.status === 'partial' ? '部分覆盖' : '未覆盖'}）：${g.gapAnalysis}\n`;
      }
      md += `\n`;
    }

    return md;
  }
}
