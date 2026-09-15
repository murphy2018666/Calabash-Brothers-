/**
 * J1: Helm 打包达标 — 测试套件
 *
 * 覆盖 Chart 结构验证、安装耗时验证、并发安装一致性：
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { HelmChartValidator, HelmInstallSimulator, validateInstallTime } from './j1-helm-install';

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 辅助：创建临时 Helm Chart 目录
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

function createTempChart(extraFiles: Record<string, string> = {}): string {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'helm-test-'));
  const chartPath = path.join(tmpDir, 'aegisci');
  fs.mkdirSync(chartPath, { recursive: true });

  // 创建必要文件
  fs.writeFileSync(path.join(chartPath, 'Chart.yaml'), JSON.stringify({
    apiVersion: 'v2',
    name: 'aegisci',
    version: '1.0.0',
    appVersion: '1.0.0',
    description: 'AegisCI Helm Chart',
    keywords: ['cicd', 'pipeline'],
    maintainers: [{ name: 'AegisCI Team', email: 'team@aegisci.io' }],
  }));
  fs.writeFileSync(path.join(chartPath, 'values.yaml'), JSON.stringify({
    replicaCount: 1,
    image: { repository: 'aegisci/control-plane', tag: 'latest' },
  }));

  // 创建 templates 目录及核心模板
  const templatesDir = path.join(chartPath, 'templates');
  fs.mkdirSync(templatesDir, { recursive: true });
  fs.writeFileSync(path.join(templatesDir, 'deployment.yaml'), 'apiVersion: apps/v1\nkind: Deployment\n');
  fs.writeFileSync(path.join(templatesDir, 'service.yaml'), 'apiVersion: v1\nkind: Service\n');

  // 添加额外文件
  for (const [name, content] of Object.entries(extraFiles)) {
    fs.writeFileSync(path.join(chartPath, name), content);
  }

  return chartPath;
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 测试套件
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

describe('J1: Helm Install Validation', () => {
  describe('HelmChartValidator', () => {
    it('J1-1-1: valid chart structure passes validation', () => {
      const chartPath = createTempChart();
      const result = HelmChartValidator.validateStructure(chartPath);
      expect(result.valid).toBe(true);
      expect(result.structure['Chart.yaml']).toBe(true);
      expect(result.structure['values.yaml']).toBe(true);
      expect(result.structure['templates']).toBe(true);
      expect(result.errors).toHaveLength(0);
      expect(result.warnings).toHaveLength(0);
    });

    it('J1-1-2: missing Chart.yaml fails validation', () => {
      const chartPath = createTempChart();
      fs.unlinkSync(path.join(chartPath, 'Chart.yaml'));
      const result = HelmChartValidator.validateStructure(chartPath);
      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.includes('Chart.yaml'))).toBe(true);
    });

    it('J1-1-3: missing templates directory fails validation', () => {
      const chartPath = createTempChart();
      fs.rmSync(path.join(chartPath, 'templates'), { recursive: true });
      const result = HelmChartValidator.validateStructure(chartPath);
      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.includes('templates'))).toBe(true);
    });

    it('J1-1-4: parseChartYaml returns manifest', () => {
      const chartPath = createTempChart();
      const manifest = HelmChartValidator.parseChartYaml(chartPath);
      expect(manifest).not.toBeNull();
      expect(manifest!.name).toBe('aegisci');
      expect(manifest!.version).toBe('1.0.0');
    });

    it('J1-1-5: validateDependencies flags invalid repo URL', () => {
      const manifest = {
        apiVersion: 'v2', name: 'aegisci', version: '1.0.0', appVersion: '1.0.0',
        description: '', keywords: [], maintainers: [],
        dependencies: [{ name: 'postgres', version: '11.0.0', repository: 'invalid-url' }],
      };
      const issues = HelmChartValidator.validateDependencies(manifest);
      expect(issues.length).toBeGreaterThan(0);
    });
  });

  describe('HelmInstallSimulator', () => {
    let simulator: HelmInstallSimulator;

    beforeEach(() => {
      simulator = new HelmInstallSimulator();
    });

    it('J1-2-1: single install succeeds within budget', () => {
      const chartPath = createTempChart();
      const result = simulator.simulateInstall({
        chartPath,
        releaseName: 'aegisci-prod',
        namespace: 'aegis-ci',
      });
      expect(result.ok).toBe(true);
      expect(result.durationMs).toBeGreaterThan(0);
      expect(result.durationMs).toBeLessThan(1_800_000); // 30 min budget
      expect(result.releaseName).toBe('aegisci-prod');
      expect(result.namespace).toBe('aegis-ci');
    });

    it('J1-2-2: install with invalid chart fails gracefully', () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'helm-invalid-'));
      const result = simulator.simulateInstall({
        chartPath: tmpDir,
        releaseName: 'aegisci-bad',
        namespace: 'aegis-ci',
      });
      expect(result.ok).toBe(false);
      expect(result.issues.length).toBeGreaterThan(0);
    });

    it('J1-2-3: concurrent installs all succeed independently', async () => {
      const chartPath = createTempChart();
      const params = Array.from({ length: 5 }, (_, i) => ({
        chartPath,
        releaseName: `aegisci-${i}`,
        namespace: 'aegis-ci',
      }));

      const results = await simulator.simulateConcurrentInstall(params);
      expect(results.length).toBe(5);
      expect(results.every((r) => r.ok)).toBe(true);
      expect(results.every((r) => r.durationMs > 0)).toBe(true);
    });

    it('J1-2-4: concurrent installs complete within total budget', async () => {
      const chartPath = createTempChart();
      const params = Array.from({ length: 10 }, (_, i) => ({
        chartPath,
        releaseName: `aegisci-concurrent-${i}`,
        namespace: 'aegis-ci',
      }));

      const start = performance.now();
      const results = await simulator.simulateConcurrentInstall(params);
      const elapsed = performance.now() - start;

      expect(results.every((r) => r.ok)).toBe(true);
      expect(elapsed).toBeLessThan(1_800_000); // 30 min budget
    });
  });

  describe('validateInstallTime', () => {
    it('J1-3-1: install within 30min budget passes', () => {
      const result = validateInstallTime(60_000); // 1 min
      expect(result.ok).toBe(true);
      expect(result.budget).toBe(1_800_000);
      expect(result.margin).toBe(1_740_000);
    });

    it('J1-3-2: install exceeding 30min budget fails', () => {
      const result = validateInstallTime(2_000_000); // > 30 min
      expect(result.ok).toBe(false);
      expect(result.margin).toBe(-200_000);
    });

    it('J1-3-3: exact budget match passes', () => {
      const result = validateInstallTime(1_800_000);
      expect(result.ok).toBe(true);
      expect(result.margin).toBe(0);
    });
  });
});
