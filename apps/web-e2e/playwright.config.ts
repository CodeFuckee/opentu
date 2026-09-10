import { defineConfig, devices } from '@playwright/test';
import { nxE2EPreset } from '@nx/playwright/preset';

import { workspaceRoot } from '@nx/devkit';
import { E2E_STATE_PATH } from './src/config/e2e.config';

// For CI, you may want to set BASE_URL to the deployed application.
const baseURL = process.env['BASE_URL'] || 'http://localhost:7200';

// 仅运行 feedbackland 项目时跳过本地 webServer（被测对象是外部 8090 站点，
// 与 localhost:7200 无关）；也可以用 E2E_SKIP_WEBSERVER=1 强制跳过
const cliArgs = process.argv;
const projectArgs = cliArgs
  .filter((a) => a.startsWith('--project='))
  .map((a) => a.split('=')[1] ?? '');
const onlyFeedbackland =
  projectArgs.length > 0 && projectArgs.every((p) => p === 'feedbackland');

// 认证 setup 保存的会话文件（路径统一在 src/config/e2e.config.ts）
const storageStatePath = E2E_STATE_PATH;

/**
 * Read environment variables from file.
 * https://github.com/motdotla/dotenv
 */
// require('dotenv').config();

/**
 * See https://playwright.dev/docs/test-configuration.
 */
export default defineConfig({
  ...nxE2EPreset(__filename, { testDir: './src' }),

  /* 测试超时设置 */
  timeout: 60000,
  expect: {
    timeout: 10000,
    toHaveScreenshot: {
      maxDiffPixelRatio: 0.05,
    },
  },

  /* 测试报告设置 */
  reporter: [
    ['html', { outputFolder: 'playwright-report' }],
    ['json', { outputFile: 'test-results/results.json' }],
    ['list'],
  ],

  /* 截图和视频设置 */
  outputDir: 'test-results',

  /* Shared settings for all the projects below. See https://playwright.dev/docs/api/class-testoptions. */
  use: {
    baseURL,
    /* Collect trace when retrying the failed test. See https://playwright.dev/docs/trace-viewer */
    trace: 'on-first-retry',
    /* 失败时截图 */
    screenshot: 'only-on-failure',
    /* 视频录制 */
    video: 'retain-on-failure',
  },

  /* Run your local dev server before starting the tests.
     E2E_WEB_SERVER=preview 时改用生产构建 + vite preview：CI 必须跑真实打包产物，
     否则只打包才会暴露的问题（如 manualChunks 环导致的顶层初始化崩溃、
     tool-windows chunk 启动报错）在 dev server 下永远测不出来。
     仅运行 feedbackland 项目（被测对象是外部 8090 站点）或设置
     E2E_SKIP_WEBSERVER=1 时跳过本地 webServer */
  webServer:
    onlyFeedbackland ||
    process.env['E2E_SKIP_WEBSERVER'] === '1'
      ? undefined
      : process.env.E2E_WEB_SERVER === 'preview'
      ? {
          command:
            'pnpm exec nx build web && pnpm exec vite preview --config apps/web/vite.config.ts --port 7200 --strictPort',
          url: 'http://localhost:7200',
          reuseExistingServer: true,
          cwd: workspaceRoot,
          timeout: 600000,
          // 显式注入构建环境：禁用 CDN 入口改写、钉死内网 Supabase 地址，
          // 覆盖本机 gitignored apps/web/.env（避免烘焙 https/生产地址导致登录失败）
          env: {
            AITU_REWRITE_ENTRY_ASSETS_TO_CDN: '0',
            VITE_SUPABASE_URL: 'http://10.37.80.25:8021',
            VITE_SUPABASE_ANON_KEY:
              'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJyb2xlIjoiYW5vbiIsImlzcyI6InN1cGFiYXNlIiwiaWF0IjoxNzg4MTAyMzUyLCJleHAiOjIxMDM0NjIzNTJ9.nQP_hdmnIbCgVfsxlq6TTuRo_FKVYdrRaIDmKViiEBc',
          },
        }
      : {
          command: 'npx nx serve web',
          url: 'http://localhost:7200',
          reuseExistingServer: !process.env.CI,
          cwd: workspaceRoot,
          timeout: 120000,
        },

  projects: [
    // 认证 setup - 先注册一次性测试账号并登录，保存会话供其它项目复用
    {
      name: 'auth-setup',
      testMatch: '**/setup/**/*.ts',
      use: { ...devices['Desktop Chrome'] },
    },

    // 冒烟测试 - 仅 Chromium，快速运行
    {
      name: 'smoke',
      testMatch: '**/smoke/**/*.spec.ts',
      use: {
        ...devices['Desktop Chrome'],
        storageState: storageStatePath,
      },
      dependencies: ['auth-setup'],
    },

    // 视觉回归测试 - 仅 Chromium
    {
      name: 'visual',
      testMatch: '**/visual/**/*.spec.ts',
      use: {
        ...devices['Desktop Chrome'],
        storageState: storageStatePath,
      },
      dependencies: ['auth-setup'],
    },

    // 功能测试 - 多浏览器
    {
      name: 'chromium',
      testMatch: '**/features/**/*.spec.ts',
      use: {
        ...devices['Desktop Chrome'],
        storageState: storageStatePath,
      },
      dependencies: ['auth-setup'],
    },

    {
      name: 'firefox',
      testMatch: '**/features/**/*.spec.ts',
      use: {
        ...devices['Desktop Firefox'],
        storageState: storageStatePath,
      },
      dependencies: ['auth-setup'],
    },

    {
      name: 'webkit',
      testMatch: '**/features/**/*.spec.ts',
      use: {
        ...devices['Desktop Safari'],
        storageState: storageStatePath,
      },
      dependencies: ['auth-setup'],
    },

    // 补充功能测试 - 仅 Chromium（与 features 平行的更细粒度覆盖）
    {
      name: 'functional',
      testMatch: '**/functional/**/*.spec.ts',
      use: {
        ...devices['Desktop Chrome'],
        storageState: storageStatePath,
      },
      dependencies: ['auth-setup'],
    },

    // 手册截图生成测试 - 仅 Chromium，排除 GIF 录制测试
    {
      name: 'manual',
      testMatch: '**/manual-gen/**/*.spec.ts',
      testIgnore: '**/manual-gen/gif-*.spec.ts', // 排除 GIF 录制测试
      use: {
        ...devices['Desktop Chrome'],
        storageState: storageStatePath,
      },
      dependencies: ['auth-setup'],
    },

    // 手册 GIF 视频录制 - 需要视频录制功能
    {
      name: 'manual-video',
      testMatch: '**/manual-gen/gif-*.spec.ts', // 只匹配 GIF 录制测试
      use: {
        ...devices['Desktop Chrome'],
        video: 'on',
        viewport: { width: 1280, height: 720 },
        storageState: storageStatePath,
      },
      dependencies: ['auth-setup'],
    },

    // 手册侧边栏导航 - 开发环境（本地 dev server 托管 apps/web/public/user-manual，
    // 无需登录态，不依赖 auth-setup）
    {
      name: 'manual-nav',
      testMatch: '**/manual-nav/**/*.spec.ts',
      use: { ...devices['Desktop Chrome'] },
    },

    // 手册侧边栏导航 - 生产环境（内网部署，可用 MANUAL_PROD_BASE_URL 覆盖）
    {
      name: 'manual-nav-prod',
      testMatch: '**/manual-nav/**/*.spec.ts',
      use: {
        ...devices['Desktop Chrome'],
        baseURL:
          process.env['MANUAL_PROD_BASE_URL'] || 'http://10.37.80.25:8088',
      },
    },

    // Feedbackland（8090 生产预览实例）Supabase 账号登录 E2E——
    // 登录流程本身即被测对象，不依赖 auth-setup 登录态
    {
      name: 'feedbackland',
      testMatch: '**/feedbackland/**/*.spec.ts',
      use: {
        ...devices['Desktop Chrome'],
        baseURL:
          process.env['FEEDBACKLAND_BASE_URL'] || 'http://10.37.80.25:8090',
      },
    },

    // 响应式测试 - 多视口尺寸
    {
      name: 'responsive',
      testMatch: '**/visual/responsive-visual.spec.ts',
      use: {
        ...devices['Desktop Chrome'],
        storageState: storageStatePath,
      },
      dependencies: ['auth-setup'],
    },

    // 移动端浏览器测试
    {
      name: 'mobile-chrome',
      testMatch: '**/visual/responsive-visual.spec.ts',
      use: {
        ...devices['Pixel 5'],
        storageState: storageStatePath,
      },
      dependencies: ['auth-setup'],
    },
    {
      name: 'mobile-safari',
      testMatch: '**/visual/responsive-visual.spec.ts',
      use: {
        ...devices['iPhone 12'],
        storageState: storageStatePath,
      },
      dependencies: ['auth-setup'],
    },

    // 平板测试
    {
      name: 'tablet',
      testMatch: '**/visual/responsive-visual.spec.ts',
      use: {
        ...devices['iPad Pro 11'],
        storageState: storageStatePath,
      },
      dependencies: ['auth-setup'],
    },

    // Uncomment for branded browsers
    /* {
      name: 'Microsoft Edge',
      use: { ...devices['Desktop Edge'], channel: 'msedge' },
    },
    {
      name: 'Google Chrome',
      use: { ...devices['Desktop Chrome'], channel: 'chrome' },
    }, */
  ],
});