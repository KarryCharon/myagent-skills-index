#!/usr/bin/env npx tsx
/**
 * MyAgent 技能市场集中索引构建(独立仓库版)。
 *
 * 从 MyAgent 主仓 scripts/build-skills-index.ts 移植而来,去除了对
 * @myagent/core / @myagent/skills 的依赖(monorepo 包未发布 npm),
 * 关键口径与主仓运行时严格同构,两边改动需人工同步:
 * - contentHash:files 清单 ASCII 排序后 `path:sha` 拼接做 fnv1aHex
 *   (对齐 packages/skills/src/marketplace.ts);
 * - frontmatter 校验子集:name 1-64 字符 + ^[a-z0-9]+(?:-[a-z0-9]+)*$ +
 *   与目录名一致;description 必填且 ≤1024 字符
 *   (对齐 packages/skills/src/parser.ts,行号级诊断这里不需要);
 * - 输出契约:{ version: 1, generatedAt, skills: MarketplaceSkill[] }
 *   (对齐 packages/skills/src/index-source.ts 的消费端)。
 *
 * 用法:
 *   npm run build                                # 读 repos.json
 *   npm run build -- --repos owner/a,owner/b     # 指定仓库(全按 community)
 *   npm run build -- --out dist/skills-index.json
 *   GITHUB_TOKEN=ghp_xxx npm run build           # 提升 API rate limit(CI 自动注入)
 *
 * 退出码:0 = 成功;1 = 失败(任一仓库枚举失败即失败,避免产出不完整索引)。
 * skills 集合与上次输出一致时保留旧 generatedAt,保证 CI 无变化不提交。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';

const API_BASE = 'https://api.github.com';
const RAW_BASE = 'https://raw.githubusercontent.com';
const REF = 'HEAD';

const SKILL_NAME_MAX_LENGTH = 64;
const SKILL_DESCRIPTION_MAX_LENGTH = 1024;
const SKILL_NAME_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

type TrustLevel = 'official' | 'trusted' | 'community';

/** 与 packages/skills/src/types.ts 的 MarketplaceSkill 同构(消费端契约)。 */
interface IndexSkill {
  id: string;
  trust: TrustLevel;
  name: string;
  description: string;
  repo: string;
  ref: string;
  path: string;
  contentHash: string;
  files: { path: string; sha: string }[];
  webUrl: string;
  version?: string;
}

// ---------------------------------------------------------------- 工具

function log(message: string): void {
  console.log(`[build-skills-index] ${message}`);
}

function warn(message: string): void {
  console.warn(`[build-skills-index] 警告:${message}`);
}

/** FNV-1a 32bit 十六进制哈希(与 packages/skills/src/marketplace.ts 逐行同构)。 */
function fnv1aHex(input: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

function dirnamePath(p: string): string {
  const index = p.lastIndexOf('/');
  return index < 0 ? '' : p.slice(0, index);
}

function basenamePath(p: string): string {
  const index = p.lastIndexOf('/');
  return index < 0 ? p : p.slice(index + 1);
}

/** 带 GITHUB_TOKEN 的文本 GET。 */
async function getText(url: string): Promise<string> {
  const headers: Record<string, string> = { Accept: 'application/vnd.github+json' };
  const token = process.env['GITHUB_TOKEN'];
  if (token) headers['Authorization'] = `Bearer ${token}`;
  const response = await fetch(url, { headers });
  if (!response.ok) {
    throw new Error(`请求失败(HTTP ${response.status}): ${url}`);
  }
  return response.text();
}

// ---------------------------------------------------------------- frontmatter 校验(主仓 parser 的子集)

interface Frontmatter {
  name: string;
  description: string;
  version?: string;
}

/** 提取并校验 SKILL.md frontmatter;不合规返回 string 错误原因。 */
function parseFrontmatter(markdown: string, expectedName: string): Frontmatter | string {
  const match = /^\uFEFF?\s*---\r?\n([\s\S]*?)\r?\n(?:---|\.\.\.)(?:\r?\n|$)/.exec(markdown);
  if (!match) return '缺少 YAML frontmatter';

  let data: unknown;
  try {
    data = parseYaml(match[1] ?? '');
  } catch (cause) {
    return `frontmatter 不是合法 YAML: ${(cause as Error).message}`;
  }
  if (typeof data !== 'object' || data === null || Array.isArray(data)) {
    return 'frontmatter 必须是键值映射';
  }
  const record = data as Record<string, unknown>;

  const name = typeof record['name'] === 'string' ? record['name'].trim() : '';
  if (name === '') return '缺少必填字段 name';
  if (name.length > SKILL_NAME_MAX_LENGTH) return `name 超长(> ${SKILL_NAME_MAX_LENGTH})`;
  if (!SKILL_NAME_RE.test(name)) return `name "${name}" 不符合命名规范`;
  if (name !== expectedName) return `name "${name}" 与目录名 "${expectedName}" 不一致`;

  const description =
    typeof record['description'] === 'string' ? record['description'].trim() : '';
  if (description === '') return '缺少必填字段 description';
  if (description.length > SKILL_DESCRIPTION_MAX_LENGTH) {
    return `description 超长(> ${SKILL_DESCRIPTION_MAX_LENGTH})`;
  }

  const metadata = record['metadata'];
  const version =
    typeof metadata === 'object' && metadata !== null && !Array.isArray(metadata)
      ? (metadata as Record<string, unknown>)['version']
      : undefined;

  return {
    name,
    description,
    ...(version !== undefined && version !== null ? { version: String(version) } : {}),
  };
}

// ---------------------------------------------------------------- 枚举

interface GitTreeEntry {
  path: string;
  type: 'blob' | 'tree' | string;
  sha: string;
}

/** 枚举单仓技能(逻辑与主仓 GitHubMarketplace.#listRepo 对齐)。 */
async function listRepo(repo: string, trust: TrustLevel): Promise<IndexSkill[]> {
  const treeText = await getText(`${API_BASE}/repos/${repo}/git/trees/${REF}?recursive=1`);
  let tree: GitTreeEntry[];
  try {
    tree = (JSON.parse(treeText) as { tree?: GitTreeEntry[] }).tree ?? [];
  } catch (cause) {
    throw new Error(`GitHub tree 响应不是合法 JSON: ${repo}`, { cause });
  }

  const skillFiles = tree.filter(
    (entry) => entry.type === 'blob' && entry.path.endsWith('/SKILL.md'),
  );

  const skills: IndexSkill[] = [];
  for (const entry of skillFiles) {
    const skillPath = dirnamePath(entry.path);
    const dirName = basenamePath(skillPath);
    const files = tree
      .filter(
        (t) => t.type === 'blob' && (t.path === entry.path || t.path.startsWith(`${skillPath}/`)),
      )
      .map((t) => ({ path: t.path.slice(skillPath.length + 1), sha: t.sha }))
      // ASCII 序而非 locale 序:保证内容哈希跨环境稳定
      .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
    const contentHash = fnv1aHex(files.map((f) => `${f.path}:${f.sha}`).join('\n'));

    let content: string;
    try {
      content = await getText(`${RAW_BASE}/${repo}/${REF}/${entry.path}`);
    } catch (error) {
      warn(`跳过 ${repo}/${entry.path}:${(error as Error).message}`);
      continue;
    }
    const frontmatter = parseFrontmatter(content, dirName);
    if (typeof frontmatter === 'string') {
      warn(`跳过 ${repo}/${entry.path}:${frontmatter}`);
      continue;
    }
    skills.push({
      id: `${repo}@${frontmatter.name}`,
      trust,
      name: frontmatter.name,
      description: frontmatter.description,
      repo,
      ref: REF,
      path: skillPath,
      contentHash,
      files,
      webUrl: `https://github.com/${repo}/tree/${REF}/${skillPath}`,
      ...(frontmatter.version !== undefined ? { version: frontmatter.version } : {}),
    });
  }
  return skills;
}

// ---------------------------------------------------------------- 入口

interface RepoEntry {
  repo: string;
  trust: TrustLevel;
}

interface CliArgs {
  repos: RepoEntry[];
  out: string;
}

function parseArgs(argv: string[]): CliArgs {
  const readValue = (flag: string): string | undefined => {
    const index = argv.indexOf(flag);
    if (index < 0) return undefined;
    const value = argv[index + 1];
    if (!value || value.startsWith('--')) throw new Error(`${flag} 需要一个参数`);
    return value;
  };

  const reposArg = readValue('--repos');
  let repos: RepoEntry[];
  if (reposArg !== undefined) {
    repos = reposArg
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s !== '')
      .map((repo) => ({ repo, trust: 'community' as const }));
  } else {
    const configPath = path.resolve(
      path.dirname(fileURLToPath(import.meta.url)),
      '../repos.json',
    );
    const config = JSON.parse(readFileSync(configPath, 'utf8')) as { repos?: RepoEntry[] };
    repos = config.repos ?? [];
  }
  if (repos.length === 0) throw new Error('没有可枚举的仓库(repos.json 为空且未传 --repos)');

  return { repos, out: readValue('--out') ?? 'skills-index.json' };
}

async function main(): Promise<void> {
  const { repos, out } = parseArgs(process.argv.slice(2));
  log(`枚举 ${repos.length} 个仓库:${repos.map((r) => r.repo).join(', ')}`);

  const skills: IndexSkill[] = [];
  for (const { repo, trust } of repos) {
    const found = await listRepo(repo, trust);
    log(`${repo}: ${found.length} 个技能(${trust})`);
    skills.push(...found);
  }

  const outPath = path.resolve(out);
  // skills 集合未变化时保留旧 generatedAt,使输出字节级不变 → CI 无变化不提交
  let generatedAt = Date.now();
  const skillsJson = JSON.stringify(skills);
  if (existsSync(outPath)) {
    try {
      const previous = JSON.parse(readFileSync(outPath, 'utf8')) as {
        generatedAt?: number;
        skills?: unknown;
      };
      if (JSON.stringify(previous.skills ?? null) === skillsJson && previous.generatedAt) {
        generatedAt = previous.generatedAt;
        log('技能集合与上次一致,保留原 generatedAt');
      }
    } catch {
      // 旧文件损坏则按全新输出处理
    }
  }

  const index = { version: 1, generatedAt, skills };
  mkdirSync(path.dirname(outPath), { recursive: true });
  writeFileSync(outPath, `${JSON.stringify(index, null, 2)}\n`);
  log(`完成:${skills.length} 个技能 → ${outPath}`);
}

main().catch((error: unknown) => {
  console.error(`[build-skills-index] 错误:${(error as Error).message}`);
  process.exit(1);
});
