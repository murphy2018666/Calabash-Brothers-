/**
 * K7-1 · PromptTemplate 加载器
 *
 * PromptTemplateLoaderService —— 从技能包中加载 prompts/*.md 模板，
 * 支持环境变量插值，加载失败时 fail-fast。
 */

import * as fs from 'fs';
import * as path from 'path';
import { Injectable, Logger } from '@nestjs/common';

export interface PromptTemplate {
  templateId: string;
  name: string;
  content: string;
  variables: string[];
  loadedAt: string;
}

export interface LoadResult {
  ok: boolean;
  templates: PromptTemplate[];
  errors: string[];
  warnings: string[];
}

@Injectable()
export class PromptTemplateLoaderService {
  private readonly logger = new Logger(PromptTemplateLoaderService.name);

  /**
   * 从技能包目录加载所有 prompts/*.md 模板。
   * @param skillPackagePath 技能包根目录路径
   * @param env 环境变量（用于模板插值）
   */
  load(skillPackagePath: string, env: Record<string, string> = {}): LoadResult {
    const errors: string[] = [];
    const warnings: string[] = [];
    const templates: PromptTemplate[] = [];

    const promptsDir = path.join(skillPackagePath, 'prompts');
    if (!fs.existsSync(promptsDir)) {
      errors.push(`prompts directory not found: ${promptsDir}`);
      return { ok: false, templates: [], errors, warnings };
    }

    const files = fs.readdirSync(promptsDir).filter((f) => f.endsWith('.md'));
    if (files.length === 0) {
      warnings.push('no prompt templates found in prompts/');
      return { ok: true, templates, errors: [], warnings };
    }

    for (const file of files) {
      const filePath = path.join(promptsDir, file);
      try {
        const content = fs.readFileSync(filePath, 'utf-8');
        const variables = this.extractVariables(content);
        const interpolated = this.interpolate(content, env);
        templates.push({
          templateId: this.templateId(file),
          name: file.replace('.md', ''),
          content: interpolated,
          variables,
          loadedAt: new Date().toISOString(),
        });
      } catch (err) {
        errors.push(`failed to load ${file}: ${(err as Error).message}`);
      }
    }

    const ok = errors.length === 0;
    if (!ok) {
      this.logger.error(`prompt template load failed: ${errors.length} errors`);
    }
    return { ok, templates, errors, warnings };
  }

  /**
   * 单个模板加载（fail-fast：缺失变量直接抛错）。
   */
  loadOne(templatePath: string, env: Record<string, string> = {}): PromptTemplate {
    const content = fs.readFileSync(templatePath, 'utf-8');
    const variables = this.extractVariables(content);
    const missing = variables.filter((v) => !(v in env));
    if (missing.length > 0) {
      throw new Error(`missing environment variables: ${missing.join(', ')}`);
    }
    return {
      templateId: this.templateId(path.basename(templatePath)),
      name: path.basename(templatePath, '.md'),
      content: this.interpolate(content, env),
      variables,
      loadedAt: new Date().toISOString(),
    };
  }

  private templateId(filename: string): string {
    return `tpl_${filename.replace('.md', '').replace(/[-_]/g, '_').toLowerCase()}`;
  }

  /**
   * 提取模板中的环境变量占位符 {{VAR_NAME}}。
   */
  private extractVariables(content: string): string[] {
    const matches = content.match(/\{\{(\w+)\}\}/g);
    if (!matches) return [];
    return [...new Set(matches.map((m) => m.slice(2, -2)))];
  }

  /**
   * 对模板内容进行环境变量插值。
   */
  private interpolate(content: string, env: Record<string, string>): string {
    return content.replace(/\{\{(\w+)\}\}/g, (_match: string, varName: string) => {
      return env[varName] ?? `_UNUSED_${varName}_`;
    });
  }
}
