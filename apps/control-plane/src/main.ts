import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';

/**
 * AegisCI 控制面启动入口。
 * - 全局前缀 /api/v1
 * - 启用 CORS
 * - 端口取自 AEGISCI_PORT（默认 3000）
 */
async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule, { cors: true });
  app.setGlobalPrefix('api/v1');
  const port = Number(process.env.AEGISCI_PORT ?? 3000);
  await app.listen(port);
  new Logger('Bootstrap').log(
    `AegisCI control-plane listening on http://localhost:${port}/api/v1`,
  );
}
void bootstrap();
