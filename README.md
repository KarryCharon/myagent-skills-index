# myagent-skills-index

MyAgent 技能市场的集中索引仓库:GitHub Actions 定时枚举 `repos.json` 中的技能仓库,产出静态 `skills-index.json`,供 MyAgent 客户端的 `IndexSource` 一次拉取——规避客户端直连 GitHub API 的 N+1 请求与 rate limit(匿名 60 次/小时)。

## 工作方式

- `repos.json`:技能来源仓库清单(`trust`: `trusted` = 白名单仓,`community` = 社区仓)
- `src/build.ts`:枚举脚本,从 MyAgent 主仓 `scripts/build-skills-index.ts` 移植的独立版本,contentHash 与 frontmatter 校验口径同主仓运行时严格同构
- `.github/workflows/build-index.yml`:每 6 小时(以及 repos.json/脚本变更时)构建,索引有变化才提交

## 客户端接入

MyAgent 配置 `modules.skills.indexUrl` 指向:

```
https://raw.githubusercontent.com/<owner>/myagent-skills-index/main/skills-index.json
```

## 本地构建

```bash
npm install
npm run build                                # 读 repos.json
npm run build -- --repos owner/a,owner/b     # 临时指定仓库(按 community)
GITHUB_TOKEN=ghp_xxx npm run build           # 提升 API rate limit
```

## 新增技能源

往 `repos.json` 加一个条目并提交即可,push 会立即触发一次构建:

```json
{ "repo": "my-org/my-skills", "trust": "community" }
```

要求目标仓库按 Agent Skills 开放标准布局(每个技能一个目录,内含带 `name`/`description` frontmatter 的 `SKILL.md`,name 与目录名一致)。不合规范的技能会在构建日志中告警并跳过。
