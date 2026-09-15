/**
 * L5-3: SummaryCompressor — 测试套件
 */

import { SummaryCompressor } from './summary-compressor';

describe('L5-3: SummaryCompressor', () => {
  const compressor = new SummaryCompressor({ maxEntries: 50, targetRatio: 0.3 });

  describe('compress', () => {
    it('L5-3-1: compress returns valid result with entries', () => {
      // Use long content so summarize() truncation actually reduces tokens
      const longContent = 'A'.repeat(500);
      const entries = Array.from({ length: 20 }, (_, i) => ({
        role: i % 2 === 0 ? 'user' : 'assistant',
        content: `Message ${i + 1}: ${longContent}`,
      }));
      const result = compressor.compress(entries);
      expect(result.ok).toBe(true);
      expect(result.entries).toHaveLength(20);
      expect(result.originalTokenCount).toBeGreaterThan(0);
      expect(result.compressionRatio).toBeLessThan(1);
    });

    it('L5-3-2: decision point entries preserve more content', () => {
      const entries = [
        { role: 'user', content: 'Run the compliance check.' },
        { role: 'assistant', content: 'Decision: COMPLY with SOC2 control A1.' },
        { role: 'tool', content: 'Compliance check completed. PASS.' },
      ];
      const result = compressor.compress(entries);
      const decisionEntries = result.entries.filter((e) => e.isDecisionPoint);
      expect(decisionEntries.length).toBeGreaterThan(0);
    });

    it('L5-3-3: compression ratio improves with more entries', () => {
      const shortEntries = Array.from({ length: 5 }, (_, i) => ({
        role: 'user',
        content: `Message ${i + 1}: hello world`,
      }));
      const longEntries = Array.from({ length: 100 }, (_, i) => ({
        role: 'user',
        content: `Message ${i + 1}: This is a longer message with more content to compress.`,
      }));

      const shortResult = compressor.compress(shortEntries);
      const longResult = compressor.compress(longEntries);

      // More entries should compress better
      expect(longResult.compressionRatio).toBeLessThan(shortResult.compressionRatio);
    });

    it('L5-3-4: entries beyond maxEntries are truncated', () => {
      const entries = Array.from({ length: 100 }, (_, i) => ({
        role: 'user',
        content: `Content ${i}`,
        timestamp: new Date(Date.now() + i * 1000).toISOString(),
      }));
      const result = compressor.compress(entries);
      expect(result.entries).toHaveLength(50); // maxEntries = 50
    });

    it('L5-3-5: entries are sorted by timestamp (newest last)', () => {
      const entries = [
        { role: 'user', content: 'Old', timestamp: new Date('2026-01-01').toISOString() },
        { role: 'assistant', content: 'New', timestamp: new Date('2026-12-31').toISOString() },
      ];
      const result = compressor.compress(entries);
      // Last entry should be the newest
      expect(result.entries[result.entries.length - 1].summary).toContain('New');
    });
  });
});
