import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html'],
      include: ['src/**/*.ts'],
      thresholds: {
        // 实测基线（2026-11-16）：stmts/lines 94.67% → 补公共入口测试后设 95%
        statements: 95,
        lines: 95,
        // 分支与函数按实测值设定，避免阈值形同虚设
        branches: 88,
        functions: 99,
      },
    },
  },
});
