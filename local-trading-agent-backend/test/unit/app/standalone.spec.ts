import { nonSpecSources, readAppFile } from '../../fixtures/repo.js';

describe('standalone context', () => {
  it('boots through createApplicationContext', () => {
    expect(readAppFile('src/main.ts')).toContain('createApplicationContext');
  });

  it.each([
    'NestFactory.create(',
    '.listen(',
    '@Controller',
    'AppController',
    'AppService',
  ])('has no %s in non-spec source', (needle) => {
    const offenders = nonSpecSources()
      .filter(({ text }) => text.includes(needle))
      .map(({ path }) => path);

    expect(offenders).toEqual([]);
  });
});
