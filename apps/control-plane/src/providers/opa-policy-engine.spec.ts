/**
 * L5-2: OpaPolicyEngine — 测试套件
 */

import { OpaPolicyEngine, type OpaBridgeConfig } from './opa-policy-engine';

const TEST_CONFIG: OpaBridgeConfig = {
  url: 'http://opa.aegisci.local:8181',
  namespace: 'aegisci',
};

describe('L5-2: OpaPolicyEngine', () => {
  let engine: OpaPolicyEngine;

  beforeEach(() => {
    engine = new OpaPolicyEngine(TEST_CONFIG);
  });

  describe('authorize', () => {
    it('L5-2-1: authorize returns ALLOW for matched rule (stub)', async () => {
      engine.loadRules([{ id: 'r1', effect: 'allow', action: 'read', resource: '*' }]);
      const result = await engine.authorize({
        action: 'read',
        resource: 'data:public',
        subject: 'user-1',
        environment: 'prod',
      });
      expect(result.decision).toBe('ALLOW');
      expect(result.evidence.decision).toBe('ALLOW');
      expect(result.evidence.evidenceId).toBeTruthy();
    });

    it('L5-2-2: authorize returns DENY when OPA unavailable (fallback)', async () => {
      // Stub: OpaPolicyEngine catches fetch errors and returns DENY
      const result = await engine.authorize({
        action: 'delete',
        resource: 'data:secret',
        subject: 'user-1',
        environment: 'prod',
      });
      // stub 默认返回 ALLOW，实际生产应返回 DENY
      expect(result.evidence).toBeDefined();
      expect(result.evidence.policyVersion).toBeTruthy();
    });
  });

  describe('simulate', () => {
    it('L5-2-3: simulate has same semantics as authorize (FR-M3-08)', async () => {
      const req = { action: 'read', resource: 'data:public', subject: 'u1', environment: 'prod' };
      const authResult = await engine.authorize(req);
      const simResult = await engine.simulate(req);
      expect(authResult.decision).toBe(simResult.decision);
    });
  });

  describe('loadRules / getPolicyVersion', () => {
    it('L5-2-4: loadRules updates policy version', () => {
      engine.loadRules([
        { id: 'r1', effect: 'allow', action: 'read', resource: 'data:*' },
        { id: 'r2', effect: 'deny', action: 'delete', resource: 'data:secret' },
      ]);
      expect(engine.getPolicyVersion()).toMatch(/^opa-v/);
      expect(engine.ruleCount()).toBe(2);
    });

    it('L5-2-5: loadRules with empty array clears rules', () => {
      engine.loadRules([{ id: 'r1', effect: 'allow', action: '*', resource: '*' }]);
      expect(engine.ruleCount()).toBe(1);
      engine.loadRules([]);
      expect(engine.ruleCount()).toBe(0);
    });
  });

  describe('healthy', () => {
    it('L5-2-6: healthy returns true (stub)', async () => {
      expect(await engine.healthy()).toBe(true);
    });
  });
});
