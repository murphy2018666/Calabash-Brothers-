const { pathsToModuleNameMapper } = require('ts-jest');
const { compilerOptions } = require('../../tsconfig.base.json');

module.exports = {
  displayName: 'cli',
  testEnvironment: 'node',
  transform: {
    '^.+\\.[tj]s$': ['ts-jest', { tsconfig: '<rootDir>/tsconfig.spec.json' }],
  },
  moduleNameMapper: {
    ...pathsToModuleNameMapper(compilerOptions.paths, {
      prefix: '<rootDir>/../../',
    }),
    '^@aegisci/domain/skill$': '<rootDir>/../domain/skill/src/index.ts',
    '^@aegisci/domain/skill/(.*)$': '<rootDir>/../domain/skill/src/$1',
    '^@aegisci/domain/policy$': '<rootDir>/../domain/policy/src/index.ts',
    '^@aegisci/domain/policy/(.*)$': '<rootDir>/../domain/policy/src/$1',
  },
  moduleFileExtensions: ['ts', 'js', 'json'],
  testMatch: ['**/*.spec.ts'],
};
