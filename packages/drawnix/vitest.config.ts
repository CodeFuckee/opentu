import { defineConfig } from 'vitest/config';
import path from 'path';

export default defineConfig({
  test: {
    globals: true,
    environment: 'jsdom',
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx'],
    exclude: ['node_modules', 'dist'],
    setupFiles: ['./vitest.setup.ts'],
    testTimeout: 30_000,
    hookTimeout: 30_000,
    maxWorkers: 2,
    coverage: {
      // 门禁：test 运行即收集覆盖率并执行阈值校验（跌破阈值测试即失败）
      enabled: true,
      provider: 'v8',
      reportsDirectory: '../../coverage/packages/drawnix',
      // 覆盖率口径限定为工作流执行引擎（核心链路零测试专项，2026-09）
      include: ['src/engine/**/*.ts'],
      exclude: ['src/engine/**/index.ts', 'src/engine/**/types/**'],
      thresholds: {
        statements: 95,
        branches: 90,
        functions: 98,
        lines: 95,
      },
    },
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
      react: path.resolve(__dirname, '../../node_modules/react'),
      'react-dom': path.resolve(__dirname, '../../node_modules/react-dom'),
      'react/jsx-runtime': path.resolve(
        __dirname,
        '../../node_modules/react/jsx-runtime.js'
      ),
      'react/jsx-dev-runtime': path.resolve(
        __dirname,
        '../../node_modules/react/jsx-dev-runtime.js'
      ),
    },
    dedupe: ['react', 'react-dom'],
  },
});
