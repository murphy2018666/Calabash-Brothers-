/**
 * NFR-S3 / T-15-01 等保三级合规自查报告服务单元测试
 *
 * 验证：
 * - S3-1 报告生成与总体覆盖度
 * - S3-2 控制域汇总统计
 * - S3-3 单个控制项查询
 * - S3-4 源码文件合规标记扫描
 * - S3-5 多文件扫描
 * - S3-6 Markdown 报告导出
 * - S3-7 覆盖率矩阵构建
 * - S3-8 边界情况（空文件、无标记文件）
 */
import {
  ComplianceCheckService,
  FR_PATTERN,
  DES_PATTERN,
  GB_PATTERN,
  ALL_COMPLIANCE_PATTERNS,
} from './compliance-check.service';

describe('NFR-S3 / T-15-01 ComplianceCheckService', () => {
  let service: ComplianceCheckService;

  beforeEach(() => {
    service = new ComplianceCheckService();
  });

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  // S3-1 报告生成与总体覆盖度
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  describe('S3-1 报告生成', () => {
    it('S3-1-1: generateReport returns a report with 29 items', () => {
      const report = service.generateReport();
      expect(report.items).toHaveLength(29);
      expect(report.standard).toBe('GB/T 22239-2019 第三级');
      expect(report.generatedAt).toBeTruthy();
    });

    it('S3-1-2: overall coverage rate matches totals', () => {
      const report = service.generateReport();
      const expectedRate = Math.round((report.total.covered / report.items.length) * 10000) / 100;
      expect(report.overallCoverageRate).toBe(expectedRate);
    });

    it('S3-1-3: total counts match item statuses', () => {
      const report = service.generateReport();
      const covered = report.items.filter(i => i.status === 'covered').length;
      const partial = report.items.filter(i => i.status === 'partial').length;
      const uncovered = report.items.filter(i => i.status === 'uncovered').length;
      expect(report.total.covered).toBe(covered);
      expect(report.total.partial).toBe(partial);
      expect(report.total.uncovered).toBe(uncovered);
      expect(covered + partial + uncovered).toBe(report.items.length);
    });

    it('S3-1-4: gaps array contains only partial and uncovered items', () => {
      const report = service.generateReport();
      expect(report.gaps.length).toBe(report.total.partial + report.total.uncovered);
      for (const gap of report.gaps) {
        expect(gap.status).not.toBe('covered');
        expect(['partial', 'uncovered']).toContain(gap.status);
      }
    });
  });

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  // S3-2 控制域汇总统计
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  describe('S3-2 控制域汇总', () => {
    it('S3-2-1: all 7 domains present in domainSummaries', () => {
      const report = service.generateReport();
      const domainNames = report.domainSummaries.map(d => d.domain);
      expect(domainNames).toEqual(['A1', 'A2', 'A3', 'A4', 'A5', 'A6', 'A7']);
    });

    it('S3-2-2: each domain summary has correct totalItems', () => {
      const report = service.generateReport();
      const domainCounts: Record<string, number> = {};
      for (const item of report.items) {
        domainCounts[item.domain] = (domainCounts[item.domain] ?? 0) + 1;
      }
      for (const ds of report.domainSummaries) {
        expect(ds.totalItems).toBe(domainCounts[ds.domain]);
      }
    });

    it('S3-2-3: domain coverageRate equals covered/totalItems*100', () => {
      const report = service.generateReport();
      for (const ds of report.domainSummaries) {
        const expectedRate = Math.round((ds.covered / ds.totalItems) * 10000) / 100;
        expect(ds.coverageRate).toBe(expectedRate);
      }
    });

    it('S3-2-4: getDomainSummary returns correct data for A3', () => {
      const summary = service.getDomainSummary('A3');
      expect(summary).not.toBeNull();
      expect(summary!.domain).toBe('A3');
      expect(summary!.totalItems).toBe(6); // A3 有 6 项
    });

    it('S3-2-5: getDomainSummary returns null for unknown domain', () => {
      expect(service.getDomainSummary('Z9')).toBeNull();
    });
  });

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  // S3-3 单个控制项查询
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  describe('S3-3 单控制项查询', () => {
    it('S3-3-1: getItemCoverage returns correct item for 8.3.3', () => {
      const item = service.getItemCoverage('8.3.3');
      expect(item).not.toBeNull();
      expect(item!.id).toBe('8.3.3');
      expect(item!.name).toBe('安全审计');
      expect(item!.domain).toBe('A3');
      expect(item!.status).toBe('covered');
      expect(item!.coverageEvidence).toBeTruthy();
      expect(item!.linkedRequirements.length).toBeGreaterThan(0);
    });

    it('S3-3-2: getItemCoverage returns partial item for 8.3.1', () => {
      const item = service.getItemCoverage('8.3.1');
      expect(item).not.toBeNull();
      expect(item!.status).toBe('partial');
      expect(item!.gapAnalysis).toBeTruthy();
    });

    it('S3-3-3: getItemCoverage returns null for non-existent item', () => {
      expect(service.getItemCoverage('99.99.99')).toBeNull();
    });

    it('S3-3-4: all items have required fields populated', () => {
      const report = service.generateReport();
      for (const item of report.items) {
        expect(item.id).toBeTruthy();
        expect(item.name).toBeTruthy();
        expect(item.domain).toBeTruthy();
        expect(item.requirement).toBeTruthy();
        expect(['covered', 'partial', 'uncovered']).toContain(item.status);
        if (item.status !== 'covered') {
          expect(item.gapAnalysis).toBeTruthy();
        }
      }
    });
  });

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  // S3-4 源码文件合规标记扫描
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  describe('S3-4 文件合规标记扫描', () => {
    const sampleFileWithMarkers = `
      /**
       * 对应等保三级 8.3.2 访问控制。等保三级 8.3.3 安全审计。
       * FR-M3-07 紧急熔断广播。
       * DES-5.2 RBAC×ABAC 实现。
       * GB/T 22239-2019 8.3.5 数据保密性。
       */
      export class MyService {}
    `;

    it('S3-4-1: scanFile finds FR pattern markers', () => {
      const found = service.scanFile(sampleFileWithMarkers);
      expect(found.has('FR-M3-07')).toBe(true);
    });

    it('S3-4-2: scanFile finds DES pattern markers', () => {
      const found = service.scanFile(sampleFileWithMarkers);
      expect(found.has('DES-5.2')).toBe(true);
    });

    it('S3-4-3: scanFile finds 等保三级 pattern markers', () => {
      const found = service.scanFile(sampleFileWithMarkers);
      expect(found.has('等保三级 8.3.2')).toBe(true);
      expect(found.has('等保三级 8.3.3')).toBe(true);
    });

    it('S3-4-4: scanFile finds GB/T pattern markers', () => {
      const found = service.scanFile(sampleFileWithMarkers);
      expect(found.has('GB/T 22239-2019 8.3.5')).toBe(true);
    });

    it('S3-4-5: scanFile returns empty set for file with no markers', () => {
      const found = service.scanFile('export class Empty {}');
      expect(found.size).toBe(0);
    });

    it('S3-4-6: scanFile handles FR-Mx-xx multi-digit IDs', () => {
      const content = 'FR-M7-08 和 FR-M3-09 都是有效引用';
      const found = service.scanFile(content);
      expect(found.has('FR-M7-08')).toBe(true);
      expect(found.has('FR-M3-09')).toBe(true);
    });
  });

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  // S3-5 多文件扫描
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  describe('S3-5 多文件扫描', () => {
    it('S3-5-1: scanFiles returns map with correct file entries', () => {
      const files = {
        'a.ts': 'FR-M3-07 测试',
        'b.ts': 'DES-5.1 另一文件',
        'c.ts': '无标记',
      };
      const result = service.scanFiles(files);
      expect(result.has('a.ts')).toBe(true);
      expect(result.has('b.ts')).toBe(true);
      expect(result.has('c.ts')).toBe(true);
      expect(result.get('a.ts')?.has('FR-M3-07')).toBe(true);
      expect(result.get('b.ts')?.has('DES-5.1')).toBe(true);
      expect(result.get('c.ts')?.size).toBe(0);
    });
  });

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  // S3-6 Markdown 报告导出
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  describe('S3-6 Markdown 导出', () => {
    it('S3-6-1: exportToMarkdown contains key sections', () => {
      const md = service.exportToMarkdown();
      expect(md).toContain('# AegisCI 等保三级合规自查报告');
      expect(md).toContain('## 一、总体覆盖度');
      expect(md).toContain('## 二、控制域汇总');
      expect(md).toContain('## 三、控制项明细');
    });

    it('S3-6-2: exportToMarkdown includes coverage rate', () => {
      const md = service.exportToMarkdown();
      expect(md).toContain('总体覆盖率');
    });

    it('S3-6-3: exportToMarkdown with custom report', () => {
      const customReport: ComplianceReport = {
        generatedAt: '2026-09-10T00:00:00Z',
        standard: 'GB/T 22239-2019 第三级',
        items: [],
        domainSummaries: [],
        overallCoverageRate: 0,
        total: { covered: 0, partial: 0, uncovered: 0 },
        gaps: [],
      };
      const md = service.exportToMarkdown(customReport);
      expect(md).toContain('2026-09-10T00:00:00Z');
    });
  });

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  // S3-7 覆盖率矩阵构建
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  describe('S3-7 覆盖率矩阵', () => {
    it('S3-7-1: buildCoverageMatrix returns all 29 items', () => {
      const map = service.scanFiles({ 'a.ts': 'FR-M3-07' });
      const matrix = service.buildCoverageMatrix(map);
      expect(Object.keys(matrix).length).toBe(29);
    });

    it('S3-7-2: buildCoverageMatrix includes markers and fileCount', () => {
      const map = service.scanFiles({ 'a.ts': 'FR-M3-07' });
      const matrix = service.buildCoverageMatrix(map);
      for (const [itemId, entry] of Object.entries(matrix)) {
        expect(Array.isArray(entry.markers)).toBe(true);
        expect(typeof entry.fileCount).toBe('number');
      }
    });
  });

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  // S3-8 正则表达式导出验证
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  describe('S3-8 合规标记正则验证', () => {
    it('S3-8-1: FR_PATTERN matches FR-M3-07 style IDs', () => {
      const text = 'FR-M3-07 FR-M7-08 FR-M5-04';
      const matches = text.match(FR_PATTERN);
      expect(matches).toEqual(['FR-M3-07', 'FR-M7-08', 'FR-M5-04']);
    });

    it('S3-8-2: DES_PATTERN matches DES-5.2 and DES-11.5', () => {
      const text = 'DES-5.2 DES-11.5 DES-3';
      const matches = text.match(DES_PATTERN);
      expect(matches).toEqual(['DES-5.2', 'DES-11.5', 'DES-3']);
    });

    it('S3-8-3: GB_PATTERN matches 等保三级 8.x.x', () => {
      const text = '等保三级 8.3.2 等保三级 8.1.1';
      const matches = text.match(GB_PATTERN);
      expect(matches).toEqual(['等保三级 8.3.2', '等保三级 8.1.1']);
    });

    it('S3-8-4: ALL_COMPLIANCE_PATTERNS has at least 7 patterns', () => {
      expect(ALL_COMPLIANCE_PATTERNS.length).toBeGreaterThanOrEqual(7);
    });
  });

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  // S3-9 边界情况
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  describe('S3-9 边界情况', () => {
    it('S3-9-1: scanFile with empty string returns empty set', () => {
      expect(service.scanFile('').size).toBe(0);
    });

    it('S3-9-2: scanFile with null-like content', () => {
      expect(service.scanFile('')).toBeInstanceOf(Set);
    });

    it('S3-9-3: scanFiles with empty record returns empty map', () => {
      const result = service.scanFiles({});
      expect(result.size).toBe(0);
    });

    it('S3-9-4: generateReport produces consistent results on repeated calls', () => {
      const r1 = service.generateReport();
      const r2 = service.generateReport();
      expect(r2.items.length).toBe(r1.items.length);
      expect(r2.overallCoverageRate).toBe(r1.overallCoverageRate);
      for (let i = 0; i < r1.items.length; i++) {
        expect(r2.items[i].status).toBe(r1.items[i].status);
      }
    });
  });
});
