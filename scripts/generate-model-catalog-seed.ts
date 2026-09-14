/**
 * 生成云端模型目录种子 SQL（model_catalog 表的初始化/全量同步脚本）。
 *
 * 数据来源：packages/drawnix/src/constants/model-config.ts 的 ALL_MODELS
 * （IMAGE/VIDEO/TEXT/AUDIO 四类静态内置模型）。
 * HIDDEN_VIDEO_MODELS（隐藏但保留参数兼容的视频模型）不同步——它们本就不应出现在选择器。
 *
 * 输出：supabase/seed/model_catalog_seed.sql（幂等 upsert，可在 Supabase 宿主机
 * 或 Studio SQL 编辑器重复执行；执行后表中条目即与本仓库静态目录一致，
 * 后续模型上下架/改名/调参直接维护表即可）。
 *
 * 用法（仓库根目录）：
 *   npx ts-node --compilerOptions '{"module":"commonjs","target":"es2020"}' scripts/generate-model-catalog-seed.ts
 */
import { writeFileSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import {
  ALL_MODELS,
  type ModelConfig,
} from '../packages/drawnix/src/constants/model-config';

const REPO_ROOT = join(__dirname, '..');
const OUTPUT_PATH = join(REPO_ROOT, 'supabase', 'seed', 'model_catalog_seed.sql');

function esc(value: string): string {
  return value.replace(/'/g, "''");
}

function textOrNull(value: string | undefined): string {
  return value == null ? 'null' : `'${esc(value)}'`;
}

function boolOrFalse(value: boolean | undefined): string {
  return value ? 'true' : 'false';
}

function intOrNull(value: number | undefined): string {
  return Number.isFinite(value as number) ? String(value) : 'null';
}

function jsonbOrNull(value: unknown): string {
  if (value == null) {
    return 'null';
  }
  return `jsonb '${esc(JSON.stringify(value))}'`;
}

function textArrayOrEmpty(value: string[] | undefined): string {
  // tags 列为 not null default '{}'，显式插入 null 会违反非空约束
  if (!value || value.length === 0) {
    return "'{}'";
  }
  return `array[${value.map((tag) => `'${esc(tag)}'`).join(', ')}]::text[]`;
}

function rowValues(model: ModelConfig): string {
  return [
    `'${esc(model.id)}'`,
    `'${esc(model.type)}'`,
    `'${esc(model.vendor)}'`,
    `'${esc(model.label)}'`,
    textOrNull(model.shortLabel),
    textOrNull(model.shortCode),
    textOrNull(model.description),
    boolOrFalse(model.isVip),
    boolOrFalse(model.supportsTools),
    intOrNull(model.recommendedScore),
    jsonbOrNull(model.imageDefaults),
    jsonbOrNull(model.videoDefaults),
    textArrayOrEmpty(model.tags),
  ].join(',\n      ');
}

const TYPE_LABELS: Record<string, string> = {
  image: '图片模型',
  video: '视频模型',
  text: '文本模型',
  audio: '音频模型',
};

const sorted = [...ALL_MODELS].sort(
  (a, b) =>
    a.type.localeCompare(b.type) || a.id.localeCompare(b.id)
);

const sections: string[] = [];
for (const type of ['image', 'video', 'text', 'audio'] as const) {
  const models = sorted.filter((model) => model.type === type);
  if (models.length === 0) {
    continue;
  }
  const values = models
    .map(
      (model) => `  (\n      ${rowValues(model)}\n  )`
    )
    .join(',\n');
  sections.push(
    `-- ${TYPE_LABELS[type]}（${models.length} 个）\n` +
      `insert into public.model_catalog (\n` +
      `  id, type, vendor, label, short_label, short_code, description,\n` +
      `  is_vip, supports_tools, recommended_score, image_defaults, video_defaults, tags\n` +
      `) values\n${values}\n` +
      `on conflict (id) do update set\n` +
      `  type = excluded.type,\n` +
      `  vendor = excluded.vendor,\n` +
      `  label = excluded.label,\n` +
      `  short_label = excluded.short_label,\n` +
      `  short_code = excluded.short_code,\n` +
      `  description = excluded.description,\n` +
      `  is_vip = excluded.is_vip,\n` +
      `  supports_tools = excluded.supports_tools,\n` +
      `  recommended_score = excluded.recommended_score,\n` +
      `  image_defaults = excluded.image_defaults,\n` +
      `  video_defaults = excluded.video_defaults,\n` +
      `  tags = excluded.tags,\n` +
      `  enabled = true,\n` +
      `  updated_at = now();`
  );
}

const header = `-- ============================================================
-- model_catalog 种子数据：静态内置模型全量同步（由
-- scripts/generate-model-catalog-seed.ts 自动生成，勿手工编辑）
--
-- 生成时间：${new Date().toISOString()}
-- 条目总数：${sorted.length}（image ${sorted.filter((m) => m.type === 'image').length} /
--   video ${sorted.filter((m) => m.type === 'video').length} /
--   text ${sorted.filter((m) => m.type === 'text').length} /
--   audio ${sorted.filter((m) => m.type === 'audio').length}）
--
-- 幂等：可重复执行；与仓库静态目录不一致的条目会被覆盖（enabled 复位为 true）。
-- 执行方式（二选一）：
--   1) Supabase 宿主机：docker exec -i supabase-db psql -U supabase_admin -d postgres < supabase/seed/model_catalog_seed.sql
--   2) Supabase Studio SQL 编辑器粘贴执行
-- 执行后前端最迟 10 分钟内（或刷新页面）自动生效；
-- 注意：会覆盖表中与仓库目录同 ID 条目的手工修改。
-- ============================================================

`;

mkdirSync(dirname(OUTPUT_PATH), { recursive: true });
writeFileSync(OUTPUT_PATH, header + sections.join('\n\n') + '\n', 'utf8');
console.log(`已生成 ${OUTPUT_PATH}`);
console.log(`条目总数: ${sorted.length}`);
for (const type of Object.keys(TYPE_LABELS)) {
  console.log(`  ${type}: ${sorted.filter((m) => m.type === type).length}`);
}
