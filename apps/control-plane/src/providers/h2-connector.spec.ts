/**
 * H2: 连接器完善 — 测试套件
 *
 * 覆盖 GitLab / GitHub / Jira / Harbor 四大连接器 stub 行为：
 *  - 事件派发与签名校验
 *  - 工单查询与状态同步
 *  - 镜像推送与签名验证
 *  - 健康检查
 */

import { EventEmitter2 } from '@nestjs/event-emitter';
import {
  GitLabConnector,
  GitHubConnector,
  JiraConnector,
  HarborConnector,
  ConnectorFactory,
} from './h2-connectors';

describe('H2: Connector Integration Tests', () => {
  const emitter = new EventEmitter2();

  // ── GitLab ─────────────────────────────────────────────────────────────────

  describe('GitLabConnector', () => {
    let connector: GitLabConnector;

    beforeEach(() => {
      connector = new GitLabConnector(
        { type: 'gitlab', baseUrl: 'https://gitlab.example.com', token: 'gl-token', tenantId: 't-h2', options: { webhookSecret: 'secret123' } },
        emitter,
      );
    });

    it('H2-1-1: dispatchEvent with valid signature succeeds', async () => {
      const payload = { object_kind: 'merge_request_event', action: 'open', 'X-Gitlab-Token': 'secret123' };
      const result = await connector.dispatchEvent(payload);
      expect(result.ok).toBe(true);
      expect(result.code).toBe(200);
      expect(result.event?.eventType).toBe('mr.created');
    });

    it('H2-1-2: dispatchEvent with wrong signature returns 401', async () => {
      const payload = { object_kind: 'push_event', 'X-Gitlab-Token': 'wrong-secret' };
      const result = await connector.dispatchEvent(payload);
      expect(result.ok).toBe(false);
      expect(result.code).toBe(401);
    });

    it('H2-1-3: verifySignature returns true for correct secret', () => {
      expect(connector.verifySignature('payload', 'secret123')).toBe(true);
    });

    it('H2-1-4: verifySignature returns false for wrong secret', () => {
      expect(connector.verifySignature('payload', 'wrong')).toBe(false);
    });

    it('H2-1-5: listBranches returns expected branches', async () => {
      const branches = await connector.listBranches('proj-1');
      expect(branches).toContain('main');
      expect(branches).toContain('develop');
    });

    it('H2-1-6: health returns ok with low latency', async () => {
      const h = await connector.health();
      expect(h.ok).toBe(true);
      expect(h.type).toBe('gitlab');
      expect(h.latencyMs).toBeLessThan(100);
    });
  });

  // ── GitHub ─────────────────────────────────────────────────────────────────

  describe('GitHubConnector', () => {
    let connector: GitHubConnector;

    beforeEach(() => {
      connector = new GitHubConnector(
        { type: 'github', baseUrl: 'https://api.github.com', token: 'gh-token', tenantId: 't-h2', options: { secret: 'whsec-test' } },
        emitter,
      );
    });

    it('H2-2-1: dispatchEvent with valid signature succeeds', async () => {
      const payload = { event_type: 'pull_request', action: 'opened', 'X-Hub-Signature': 'sha256=abc123' };
      const result = await connector.dispatchEvent(payload);
      expect(result.ok).toBe(true);
      expect(result.event?.eventType).toBe('pr.opened');
    });

    it('H2-2-2: dispatchEvent without signature returns 401', async () => {
      const payload = { event_type: 'push', action: 'push' };
      const result = await connector.dispatchEvent(payload);
      expect(result.ok).toBe(false);
      expect(result.code).toBe(401);
    });

    it('H2-2-3: filterPush matches target branch', () => {
      expect(connector.filterPush({ ref: 'refs/heads/main' }, 'main')).toBe(true);
    });

    it('H2-2-4: filterPush rejects unrelated branch', () => {
      expect(connector.filterPush({ ref: 'refs/heads/feature-x' }, 'main')).toBe(false);
    });

    it('H2-2-5: health returns ok with low latency', async () => {
      const h = await connector.health();
      expect(h.ok).toBe(true);
      expect(h.type).toBe('github');
      expect(h.latencyMs).toBeLessThan(100);
    });
  });

  // ── Jira ───────────────────────────────────────────────────────────────────

  describe('JiraConnector', () => {
    let connector: JiraConnector;

    beforeEach(() => {
      connector = new JiraConnector(
        { type: 'jira', baseUrl: 'https://jira.example.com', token: 'jira-token', tenantId: 't-h2' },
      );
      // 预置一个工单
      connector['issueStore'].set('ISSUE-1', { key: 'ISSUE-1', status: 'Done', summary: 'Fix auth bug' });
      connector['issueStore'].set('ISSUE-2', { key: 'ISSUE-2', status: 'Open', summary: 'New feature' });
    });

    it('H2-3-1: queryIssue returns known issue', async () => {
      const issue = await connector.queryIssue('ISSUE-1');
      expect(issue).not.toBeNull();
      expect(issue!.key).toBe('ISSUE-1');
    });

    it('H2-3-2: queryIssue returns null for unknown issue', async () => {
      const issue = await connector.queryIssue('ISSUE-999');
      expect(issue).toBeNull();
    });

    it('H2-3-3: syncStatus returns ok for resolved issue', async () => {
      const result = await connector.syncStatus('ISSUE-1');
      expect(result.ok).toBe(true);
      expect(result.status).toBe('Done');
    });

    it('H2-3-4: syncStatus returns not ok for open issue', async () => {
      const result = await connector.syncStatus('ISSUE-2');
      expect(result.ok).toBe(false);
      expect(result.status).toBe('Open');
    });

    it('H2-3-5: createComment stores comment on issue', async () => {
      const result = await connector.createComment('ISSUE-1', 'Gate approved');
      expect(result.ok).toBe(true);
      const issue = await connector.queryIssue('ISSUE-1');
      expect(issue!.comment).toBe('Gate approved');
    });

    it('H2-3-6: simulateFailure recovers after 3 retries', async () => {
      const r1 = await connector.simulateFailure();
      expect(r1.ok).toBe(false);
      const r2 = await connector.simulateFailure();
      expect(r2.ok).toBe(false);
      const r3 = await connector.simulateFailure();
      expect(r3.ok).toBe(true);
      expect(connector.getRetryCount()).toBe(3);
    });

    it('H2-3-7: health returns ok with low latency', async () => {
      const h = await connector.health();
      expect(h.ok).toBe(true);
      expect(h.type).toBe('jira');
      expect(h.latencyMs).toBeLessThan(100);
    });
  });

  // ── Harbor ─────────────────────────────────────────────────────────────────

  describe('HarborConnector', () => {
    let connector: HarborConnector;

    beforeEach(() => {
      connector = new HarborConnector(
        { type: 'harbor', baseUrl: 'https://harbor.example.com', token: 'harbor-token', tenantId: 't-h2' },
      );
    });

    it('H2-4-1: pushImage records digest and signed status', async () => {
      const result = await connector.pushImage('my-project/my-app', 'v1.0', 'sha256:abcd1234', true);
      expect(result.ok).toBe(true);
      const images = connector.getImages();
      expect(images.has('my-project/my-app:v1.0')).toBe(true);
      expect(images.get('my-project/my-app:v1.0')!.signed).toBe(true);
    });

    it('H2-4-2: verifySignature returns signed=true for signed image', async () => {
      await connector.pushImage('my-project/my-app', 'v1.0', 'sha256:abcd1234', true);
      const result = await connector.verifySignature('my-project/my-app', 'v1.0');
      expect(result.ok).toBe(true);
      expect(result.signed).toBe(true);
    });

    it('H2-4-3: verifySignature returns signed=false for unsigned image', async () => {
      await connector.pushImage('my-project/my-app', 'v1.0', 'sha256:efgh5678', false);
      const result = await connector.verifySignature('my-project/my-app', 'v1.0');
      expect(result.ok).toBe(true);
      expect(result.signed).toBe(false);
    });

    it('H2-4-4: listImages returns only matching repo', async () => {
      await connector.pushImage('my-project/app-a', 'v1', 'sha256:aaa', true);
      await connector.pushImage('my-project/app-b', 'v2', 'sha256:bbb', false);
      await connector.pushImage('other-project/app-c', 'v3', 'sha256:ccc', true);
      const images = await connector.listImages('my-project/app-a');
      expect(images).toEqual(['my-project/app-a:v1']);
    });

    it('H2-4-5: health returns ok with low latency', async () => {
      const h = await connector.health();
      expect(h.ok).toBe(true);
      expect(h.type).toBe('harbor');
      expect(h.latencyMs).toBeLessThan(100);
    });
  });

  // ── Factory ────────────────────────────────────────────────────────────────

  describe('ConnectorFactory', () => {
    it('H2-5-1: creates GitLabConnector for gitlab type', () => {
      const c = ConnectorFactory.create(
        { type: 'gitlab', baseUrl: 'https://gl.com', token: 't', tenantId: 't1' },
        emitter,
      );
      expect(c).toBeInstanceOf(GitLabConnector);
    });

    it('H2-5-2: creates GitHubConnector for github type', () => {
      const c = ConnectorFactory.create(
        { type: 'github', baseUrl: 'https://gh.com', token: 't', tenantId: 't1' },
        emitter,
      );
      expect(c).toBeInstanceOf(GitHubConnector);
    });

    it('H2-5-3: creates JiraConnector for jira type', () => {
      const c = ConnectorFactory.create(
        { type: 'jira', baseUrl: 'https://jira.com', token: 't', tenantId: 't1' },
        emitter,
      );
      expect(c).toBeInstanceOf(JiraConnector);
    });

    it('H2-5-4: creates HarborConnector for harbor type', () => {
      const c = ConnectorFactory.create(
        { type: 'harbor', baseUrl: 'https://harbor.com', token: 't', tenantId: 't1' },
        emitter,
      );
      expect(c).toBeInstanceOf(HarborConnector);
    });

    it('H2-5-5: throws for unknown connector type', () => {
      expect(() => {
        ConnectorFactory.create({ type: 'unknown' as any, baseUrl: 'x', token: 't', tenantId: 't1' }, emitter);
      }).toThrow(/Unknown connector type/);
    });
  });
});
