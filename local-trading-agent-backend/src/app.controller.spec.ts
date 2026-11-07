import type { INestApplicationContext } from '@nestjs/common';
import { ModulesContainer, NestFactory } from '@nestjs/core';
import { stubFixtureEnv } from '../test/fixtures/env.js';
import { AppModule } from './app.module.js';

describe('AppModule', () => {
  let context: INestApplicationContext;

  beforeEach(async () => {
    stubFixtureEnv();
    context = await NestFactory.createApplicationContext(AppModule, {
      abortOnError: false,
      logger: false,
    });
  });

  afterEach(async () => {
    await context.close();
    vi.unstubAllEnvs();
  });

  it('boots with zero controllers in every module', () => {
    const modules = [...context.get(ModulesContainer).values()];
    const names = modules.map((module) => module.metatype.name);
    const withControllers = modules
      .filter((module) => module.controllers.size > 0)
      .map((module) => module.metatype.name);

    expect(names).toEqual(
      expect.arrayContaining(['AppModule', 'ConfigModule', 'LoggerModule']),
    );
    expect(withControllers).toEqual([]);
  });
});
