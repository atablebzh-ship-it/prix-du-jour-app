module.exports = {
  testEnvironment: 'node',
  collectCoverage: true,
  coverageDirectory: 'coverage',
  coverageReporters: ['lcov', 'text'],
  collectCoverageFrom: [
    'api/**/*.js',
    'lib/**/*.js',
    '!**/node_modules/**',
  ],
  testMatch: ['**/test/**/*.test.js'],
};
