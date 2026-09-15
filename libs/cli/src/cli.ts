/**
 * K7-4 · CLI 入口
 */
import { Command } from 'commander';
import { registerSkillCommands } from './commands/skill';

const program = new Command();

program
  .name('aegisci')
  .description('AegisCI CLI 脚手架工具')
  .version('1.0.0');

registerSkillCommands(program);

if (require.main === module) {
  program.parse(process.argv);
}

export { program };
