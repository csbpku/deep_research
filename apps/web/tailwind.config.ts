import type { Config } from 'tailwindcss';

/**
 * Tailwind 迁移兼容配置 —— 视觉值只从共享设计 token 派生。
 *
 * 颜色别名由 design-system 生成到 legacy-bridge.css（shadcn HSL 三元组约定）；
 * `.dark` 在 html 上切换时，旧 utility 与 MUI 使用同一套浅深色语义。
 *
 * ⚠️ 依赖 postcss.config.js —— 没有它 @tailwind 指令不会被处理。
 */
const config: Config = {
  content: ['./src/**/*.{ts,tsx}'],
  darkMode: 'class',
  theme: {
    extend: {
      colors: {
        border: 'hsl(var(--border))',
        input: 'hsl(var(--input))',
        ring: 'hsl(var(--ring))',
        background: 'hsl(var(--background))',
        foreground: 'hsl(var(--foreground))',
        primary: {
          DEFAULT: 'hsl(var(--primary))',
          foreground: 'hsl(var(--primary-foreground))',
        },
        secondary: {
          DEFAULT: 'hsl(var(--secondary))',
          foreground: 'hsl(var(--secondary-foreground))',
        },
        destructive: {
          DEFAULT: 'hsl(var(--destructive))',
          foreground: 'hsl(var(--destructive-foreground))',
        },
        muted: {
          DEFAULT: 'hsl(var(--muted))',
          foreground: 'hsl(var(--muted-foreground))',
        },
        accent: {
          DEFAULT: 'hsl(var(--accent))',
          foreground: 'hsl(var(--accent-foreground))',
        },
        popover: {
          DEFAULT: 'hsl(var(--popover))',
          foreground: 'hsl(var(--popover-foreground))',
        },
        card: {
          DEFAULT: 'hsl(var(--card))',
          foreground: 'hsl(var(--card-foreground))',
        },

        /* ---- 领域语义色：AI 调研 job 状态 ---- */
        status: {
          'queued-bg': 'hsl(var(--status-queued-bg))',
          'queued-fg': 'hsl(var(--status-queued-fg))',
          'queued-border': 'hsl(var(--status-queued-border))',
          'running-bg': 'hsl(var(--status-running-bg))',
          'running-fg': 'hsl(var(--status-running-fg))',
          'running-border': 'hsl(var(--status-running-border))',
          'succeeded-bg': 'hsl(var(--status-succeeded-bg))',
          'succeeded-fg': 'hsl(var(--status-succeeded-fg))',
          'succeeded-border': 'hsl(var(--status-succeeded-border))',
          'failed-bg': 'hsl(var(--status-failed-bg))',
          'failed-fg': 'hsl(var(--status-failed-fg))',
          'failed-border': 'hsl(var(--status-failed-border))',
          'cancelled-bg': 'hsl(var(--status-cancelled-bg))',
          'cancelled-fg': 'hsl(var(--status-cancelled-fg))',
          'cancelled-border': 'hsl(var(--status-cancelled-border))',
          'partial-bg': 'hsl(var(--status-partial-bg))',
          'partial-fg': 'hsl(var(--status-partial-fg))',
          'partial-border': 'hsl(var(--status-partial-border))',
        },

        /* ---- 领域语义色：雷达候选生命周期 ---- */
        radar: {
          'candidate-bg': 'hsl(var(--radar-candidate-bg))',
          'candidate-fg': 'hsl(var(--radar-candidate-fg))',
          'published-bg': 'hsl(var(--radar-published-bg))',
          'published-fg': 'hsl(var(--radar-published-fg))',
          'rejected-bg': 'hsl(var(--radar-rejected-bg))',
          'rejected-fg': 'hsl(var(--radar-rejected-fg))',
          'archived-bg': 'hsl(var(--radar-archived-bg))',
          'archived-fg': 'hsl(var(--radar-archived-fg))',
          'pending-bg': 'hsl(var(--radar-pending-bg))',
          'pending-fg': 'hsl(var(--radar-pending-fg))',
        },

        /* ---- 领域语义色：Distilled score tier ---- */
        tier: {
          'deep-read': 'hsl(var(--tier-deep-read))',
          skim: 'hsl(var(--tier-skim))',
          collection: 'hsl(var(--tier-collection))',
          noise: 'hsl(var(--tier-noise))',
          track: 'hsl(var(--score-track))',
          /* 主题热度（topic hot/warming/emerging）—— 不与 score tier 混用 */
          hot: 'hsl(var(--tier-hot-fg))',
          warming: 'hsl(var(--tier-warming-fg))',
          emerging: 'hsl(var(--tier-emerging-fg))',
        },

        /* ---- 领域语义色：创作方式 ---- */
        method: {
          manual: 'hsl(var(--method-manual))',
          ai: 'hsl(var(--method-ai))',
          file: 'hsl(var(--method-file))',
          import: 'hsl(var(--method-import))',
        },

        /* ---- 警示/高亮色：原各处裸 amber palette 的收敛点 ---- */
        warning: {
          DEFAULT: 'hsl(var(--warning))',
          bg: 'hsl(var(--warning-bg))',
          border: 'hsl(var(--warning-border))',
          fg: 'hsl(var(--warning-fg))',
        },
      },

      borderRadius: {
        lg: 'var(--radius)',
        md: 'calc(var(--radius) - 2px)',
        sm: 'calc(var(--radius) - 4px)',
      },

      fontFamily: {
        // 使用系统字体，确保离线构建与中英文渲染都不依赖外部字体 CDN。
        sans: ['var(--dr-font-family)'],
        mono: [
          'ui-monospace',
          'SFMono-Regular',
          'Menlo',
          'Consolas',
          'monospace',
        ],
        // M1 新增：阅读面板正文衬线（研究论文感）。Source Serif 4 若无则回退 Georgia，
        // 两者在 macOS/Windows 均内置，不依赖外部字体 CDN，保持离线构建可用。
        serif: [
          'Source Serif 4',
          'Source Serif Pro',
          'Georgia',
          'Cambria',
          'serif',
        ],
      },

      // Data-Dense 布局尺度
      spacing: {
        sidebar: 'var(--shell-sidebar)',
        topbar: 'var(--shell-topbar)',
      },
      maxWidth: {
        // 列表/控制台页用 shell
        shell: 'var(--dr-width-shell)',
        // 中文长文阅读舒适上限。
        measure: 'var(--dr-width-reading)',
        // 列表类路由 (雷达/搜索) - 可选
        'content-list': 'var(--dr-width-content-list)',
      },

      keyframes: {
        'accordion-down': {
          from: { height: '0' },
          to: { height: 'var(--radix-accordion-content-height)' },
        },
        'accordion-up': {
          from: { height: 'var(--radix-accordion-content-height)' },
          to: { height: '0' },
        },
        'indeterminate-bar': {
          '0%': { transform: 'translateX(-100%)' },
          '100%': { transform: 'translateX(400%)' },
        },
        'sheet-slide-up': {
          from: { transform: 'translateY(100%)', opacity: '0' },
          to: { transform: 'translateY(0)', opacity: '1' },
        },
      },
      animation: {
        'accordion-down': 'accordion-down 0.2s ease-out',
        'accordion-up': 'accordion-up 0.2s ease-out',
        'indeterminate-bar': 'indeterminate-bar 1.4s ease-in-out infinite',
        'sheet-slide-up': 'sheet-slide-up 0.3s ease-out',
      },
    },
  },
  plugins: [require('tailwindcss-animate'), require('@tailwindcss/typography')],
};

export default config;
