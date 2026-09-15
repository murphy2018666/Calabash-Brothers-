/**
 * K7-4 · aegisci CLI 脚手架 —— skill 子命令
 *
 * 四个命令：init / build / push / enable
 * 用于快速创建、打包、发布和管理 Agent Skill / PolicyPack
 */

import { Command, Option } from 'commander';
import * as fs from 'fs';
import * as path from 'path';
import { YAML } from '../yaml-stub';
import { ReviewPipelineOrchestrator, PolicySimulateStep, ConvergenceCheckStep } from '@aegisci/domain/skill';
import {
  SignatureVerificationStep,
  SchemaLintStep,
  DependencyScanStep,
  PromptInjectionScanStep,
  ComplianceGateStep,
  RealComplianceAssessor,
} from '@aegisci/domain/skill';

/** Stub PolicySimulator: 所有模拟请求返回 ALLOW */
const stubPolicySimulator = {
  simulate: async () => ({ decision: 'ALLOW' as const, evidence: { evidenceId: 'stub', policyVersion: '0.0.0', decision: 'ALLOW' as const, reason: 'stub allow', rules: [], timestamp: new Date().toISOString() }, cacheHit: false }),
};

/** Stub ConvergenceChecker: 始终返回 neutral (通过) */
const stubConvergenceChecker = {
  checkConvergence: () => ({ ok: true, direction: 'neutral' as const, conflicts: [], changes: [] }),
};

export function registerSkillCommands(program: Command): void {
  const skill = program.command('skill').description('技能包管理工具');

  // init 命令
  skill
    .command('init <name>')
    .option('--type agent|policy-pack|tool|connector', '技能类型', 'agent')
    .option('--dir <path>', '输出目录', '.')
    .action((name, options) => {
      const type = (options.type as any) || 'agent';
      const outDir = path.resolve(options.dir);
      const skillDir = path.join(outDir, name);

      if (fs.existsSync(skillDir)) {
        console.error(`目录已存在: ${skillDir}`);
        process.exit(1);
      }

      const templateType = type === 'policy-pack' ? 'policy' : 'agent';
      const baseDirs = ['src', 'prompts', 'policies', 'tests'];
      if (type === 'tool' || type === 'connector') baseDirs.push('tools');

      for (const d of baseDirs) {
        fs.mkdirSync(path.join(skillDir, d), { recursive: true });
      }

      // skill.yaml
      const manifest = {
        name,
        version: '1.0.0',
        type,
        description: `${type} 技能`,
        riskTier: 'G2',
        author: '',
        tags: [],
        prompts: [],
        dependencies: [],
        protocols: [],
      };
      fs.writeFileSync(
        path.join(skillDir, 'skill.yaml'),
        `# AegisCI Skill Manifest (DES-11.2)\nname: ${name}\nversion: ${manifest.version}\ntype: ${type}\ndescription: ${manifest.description}\nriskTier: ${manifest.riskTier}\nauthor: ${manifest.author}\ntags:\n  - ${type}\nprompts: []\ndependencies: []\nprotocols: []\n`,
        'utf-8',
      );

      // 占位文件
      fs.writeFileSync(path.join(skillDir, 'src', 'index.ts'), `// ${name} entry point\n`);
      fs.writeFileSync(
        path.join(skillDir, 'prompts', 'default.md'),
        `# ${name} Default Prompt\n\n{{context}}\n`,
      );
      fs.writeFileSync(path.join(skillDir, 'tests', 'index.spec.ts'), `// ${name} tests\n`);

      console.log(`✅ 已创建技能包: ${skillDir}`);
      console.log(`   类型: ${type}`);
      console.log(`   目录结构: ${baseDirs.join(', ')}`);
    });

  // build 命令
  skill
    .command('build <path>')
    .option('--output <dir>', '输出目录', './dist')
    .action((inputPath, options) => {
      const srcDir = path.resolve(inputPath);
      const manifestPath = path.join(srcDir, 'skill.yaml');
      if (!fs.existsSync(manifestPath)) {
        console.error(`未找到 skill.yaml: ${manifestPath}`);
        process.exit(1);
      }
      const manifest = YAML.parse(fs.readFileSync(manifestPath, 'utf-8'));
      console.log(`📦 正在构建技能: ${manifest.name}@${manifest.version}`);
      // Stub: 真实实现需调用 OCI builder
      console.log('✅ 构建完成（stub 模式，未执行真实打包）');
    });

  // push 命令
  skill
    .command('push <path>')
    .option('--registry <url>', 'OCI 仓库地址', 'https://registry.aegisci.local')
    .option('--dry-run', '仅执行评审，不实际推送', false)
    .action(async (inputPath, options) => {
      const srcDir = path.resolve(inputPath);
      const manifestPath = path.join(srcDir, 'skill.yaml');
      if (!fs.existsSync(manifestPath)) {
        console.error(`未找到 skill.yaml: ${manifestPath}`);
        throw new Error(`未找到 skill.yaml: ${manifestPath}`);
      }

      const manifest = YAML.parse(fs.readFileSync(manifestPath, 'utf-8')) as Record<string, any>;
      const skillId = String(manifest.name || path.basename(srcDir));
      const registry = options.registry;

      console.log(`🔍 评审前检测: ${skillId}@${manifest.version}`);

      // 构建 SkillRecord（CLI 环境无签名验证，signatureVerified=true 作为 stub）
      const record = {
        skillId,
        manifest: manifest as any,
        state: 'registered' as any,
        signatureVerified: true,
        installedAt: new Date().toISOString(),
        tenantId: 'default',
      };

      // 实例化评审流水线（CLI 无 NestJS DI，手动 new）
      const orchestrator = new ReviewPipelineOrchestrator(
        new SignatureVerificationStep(),
        new SchemaLintStep(),
        new DependencyScanStep(),
        new PromptInjectionScanStep(),
        new PolicySimulateStep(stubPolicySimulator),
        new ConvergenceCheckStep(stubConvergenceChecker),
        new ComplianceGateStep(new RealComplianceAssessor()),
      );

      // 执行完整 7 步评审
      const results = await orchestrator.run(record);

      // 汇总评审结果
      const passedSteps = results.steps.filter((r) => r.passed);
      const failedSteps = results.steps.filter((r) => !r.passed);

      if (failedSteps.length > 0) {
        const messages = failedSteps.map((f) => `[${f.step}] ${f.message}`).join('; ');
        console.error('❌ 评审未通过，push 中止：');
        for (const f of failedSteps) {
          console.error(`  [${f.step}] ${f.message}`);
        }
        console.log('\n📋 评审证据 IDs:');
        for (const r of results.steps) {
          console.log(`  ${r.evidenceId}`);
        }
        throw new Error(`评审未通过，push 中止: ${messages}`);
      }

      console.log(`✅ ${results.steps.length}/${results.steps.length} 步评审通过`);

      if (options.dryRun) {
        console.log('⚠️  dry-run 模式：跳过实际推送');
        return;
      }

      // 评审通过，继续推送
      console.log(`🚀 推送技能 ${skillId}@${manifest.version} 到: ${registry}`);
      console.log('✅ push 完成（stub 模式，未连接真实 Registry）');
    });

  // enable 命令
  skill
    .command('enable <skillId>')
    .option('--tenant <id>', '租户 ID', 'default')
    .action((skillId, options) => {
      console.log(`✅ 技能 ${skillId} 已激活（stub 模式）`);
      console.log(`   tenantId: ${options.tenant}`);
    });

  // pull 命令（K8b-3）
  skill
    .command('pull <skillId>')
    .option('--version <version>', '技能版本', 'latest')
    .option('--output <dir>', '输出目录', './skills')
    .option('--registry <url>', 'Registry 地址', 'https://registry.aegisci.local')
    .action((skillId, options) => {
      const outputDir = path.resolve(options.output);
      const registry = options.registry;

      if (!fs.existsSync(outputDir)) {
        fs.mkdirSync(outputDir, { recursive: true });
      }

      console.log(`📥 拉取技能 ${skillId}@${options.version} 从: ${registry}`);
      console.log(`📂 输出目录: ${outputDir}`);
      console.log('✅ pull 完成（stub 模式，未连接真实 Registry）');
    });

  // sync 命令（K8b-3）
  skill
    .command('sync')
    .option('--policy <path>', '同步策略文件路径', '.aegisci/sync-policy.yaml')
    .option('--registry <url>', '公共市场 Registry', 'https://public-market.aegisci.local')
    .action((options) => {
      const policyPath = path.resolve(options.policy);
      let policyText = '';
      try {
        policyText = fs.readFileSync(policyPath, 'utf-8');
      } catch {
        console.log(`⚠️  未找到策略文件: ${policyPath}，使用默认策略`);
      }

      console.log(`🔄 执行同步（策略: ${policyPath}）`);
      console.log(`🌐 公共市场: ${options.registry}`);
      console.log('✅ sync 完成（stub 模式，未连接真实同步调度器）');
    });
}
