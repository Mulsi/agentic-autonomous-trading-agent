import { Module } from '@nestjs/common';
import { LoggerModule } from 'nestjs-pino';
import { ConfigModule } from './config/config.module.js';
import { pinoOptions } from './config/logging.js';

@Module({
  imports: [ConfigModule, LoggerModule.forRoot({ pinoHttp: pinoOptions })],
})
export class AppModule {}
