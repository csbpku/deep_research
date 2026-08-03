/**
 * PostCSS 配置。
 *
 * ⚠️ 这个文件之前是缺失的，导致 `@tailwind` 指令从未被处理 —— 构建产物
 * `.next/static/css/app/layout.css` 里留着原样的 `@tailwind base;` 文本。
 * Next.js 内置的 PostCSS 默认链**不包含** Tailwind 插件，必须显式声明。
 *
 * 验证方式：`pnpm build` 后
 *   grep -c "box-sizing:border-box" .next/static/css/app/*.css
 * 应 > 0（修复前为 0）。
 */
module.exports = {
  plugins: {
    tailwindcss: {},
    autoprefixer: {},
  },
};
