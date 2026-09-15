/**
 * J1: Helm 打包达标 — 安装时间验证 stub
 *
 * 验证 Helm Chart 的包结构完整性与"30 分钟安装达标"目标的 stub 验证：
 *  - Chart.yaml / values.yaml / templates/ 结构校验
 *  - 安装耗时计算（从 chart 准备到 ready 标志）
 *  - 多实例并发安装一致性
 *
 * 对应 WBS: J1 (1.9.1 Helm打包30分钟安装达标)
 */

import * as fs from 'fs';
import * as path from 'path';

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// J1 类型定义
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

export interface HelmChartManifest {
  apiVersion: string;
  name: string;
  version: string;
  appVersion: string;
  description: string;
  keywords: string[];
  maintainers: Array<{ name: string; email: string }>;
  dependencies?: Array<{ name: string; version: string; repository: string }>;
}

export interface InstallResult {
  ok: boolean;
  durationMs: number;
  releaseName: string;
  namespace: string;
  readyAt: string;
  issues: string[];
}

export interface ChartValidationResult {
  valid: boolean;
  errors: string[];
  warnings: string[];
  structure: Record<string, boolean>;
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// J1 HelmChartValidator
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

export class HelmChartValidator {
  /**
   * validateStructure —— 验证 Helm Chart 目录结构
   * 必须包含：Chart.yaml, values.yaml, templates/
   */
  static validateStructure(chartPath: string): ChartValidationResult {
    const errors: string[] = [];
    const warnings: string[] = [];
    const structure: Record<string, boolean> = {};

    const requiredFiles = ['Chart.yaml', 'values.yaml'];
    const requiredDirs = ['templates'];

    for (const f of requiredFiles) {
      const exists = fs.existsSync(path.join(chartPath, f));
      structure[f] = exists;
      if (!exists) errors.push(`Missing required file: ${f}`);
    }

    for (const d of requiredDirs) {
      const exists = fs.existsSync(path.join(chartPath, d));
      structure[d] = exists;
      if (!exists) errors.push(`Missing required directory: ${d}`);
    }

    // 检查 templates 目录下是否有核心模板
    const templatesDir = path.join(chartPath, 'templates');
    if (fs.existsSync(templatesDir)) {
      const templates = fs.readdirSync(templatesDir);
      const hasDeployment = templates.some((t) => t.includes('deployment'));
      const hasService = templates.some((t) => t.includes('service'));
      if (!hasDeployment) warnings.push('No deployment template found');
      if (!hasService) warnings.push('No service template found');
    }

    return {
      valid: errors.length === 0,
      errors,
      warnings,
      structure,
    };
  }

  /**
   * parseChartYaml —— 解析 Chart.yaml 获取元信息
   */
  static parseChartYaml(chartPath: string): HelmChartManifest | null {
    const chartYamlPath = path.join(chartPath, 'Chart.yaml');
    if (!fs.existsSync(chartYamlPath)) return null;
    const content = fs.readFileSync(chartYamlPath, 'utf-8');
    // 简单 YAML 解析（stub 使用 JSON 格式兼容）
    try {
      return JSON.parse(content.replace(/^[^{]/, '{').replace(/[^}]+$/, '}')) as HelmChartManifest;
    } catch {
      return null;
    }
  }

  /**
   * validateDependencies —— 验证依赖声明
   */
  static validateDependencies(manifest: HelmChartManifest): string[] {
    const issues: string[] = [];
    if (manifest.dependencies) {
      for (const dep of manifest.dependencies) {
        if (!dep.repository.startsWith('http') && !dep.repository.startsWith('./')) {
          issues.push(`Dependency ${dep.name}: invalid repository URL`);
        }
      }
    }
    return issues;
  }
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// J1 HelmInstallSimulator
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

export class HelmInstallSimulator {
  private readonly installations = new Map<string, InstallResult>();

  /**
   * simulateInstall —— 模拟 Helm 安装流程
   * 计算从 chart 准备到 ready 的耗时
   */
  simulateInstall(params: {
    chartPath: string;
    releaseName: string;
    namespace: string;
    valuesFile?: string;
  }): InstallResult {
    const start = performance.now();

    // 验证 chart 结构
    const validation = HelmChartValidator.validateStructure(params.chartPath);
    if (!validation.valid) {
      return {
        ok: false,
        durationMs: performance.now() - start,
        releaseName: params.releaseName,
        namespace: params.namespace,
        readyAt: '',
        issues: validation.errors,
      };
    }

    // stub 安装延迟：50ms（真实场景为秒级，此处仅为基准测试）
    const simulatedDelay = 50;
    const durationMs = performance.now() - start + simulatedDelay;

    const result: InstallResult = {
      ok: true,
      durationMs,
      releaseName: params.releaseName,
      namespace: params.namespace,
      readyAt: new Date().toISOString(),
      issues: validation.warnings,
    };

    this.installations.set(params.releaseName, result);
    return result;
  }

  /**
   * simulateConcurrentInstall —— 并发模拟多实例安装
   */
  async simulateConcurrentInstall(params: Array<{
    chartPath: string;
    releaseName: string;
    namespace: string;
  }>): Promise<InstallResult[]> {
    return Promise.all(params.map((p) => this.simulateInstall(p)));
  }

  /**
   * getResults —— 获取所有安装结果
   */
  getResults(): Map<string, InstallResult> {
    return this.installations;
  }
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// J1 目标：30 分钟安装达标
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/**
 * validateInstallTime —— 验证安装耗时是否满足目标
 * 目标：≤ 30 分钟（1800s = 1,800,000ms）
 * stub: 实际测试中使用 ms 级模拟，但断言目标转换正确
 */
export function validateInstallTime(durationMs: number, targetMinutes: number = 30): { ok: boolean; budget: number; actual: number; margin: number } {
  const budget = targetMinutes * 60 * 1000; // ms
  const actual = durationMs;
  return {
    ok: actual <= budget,
    budget,
    actual,
    margin: budget - actual,
  };
}
