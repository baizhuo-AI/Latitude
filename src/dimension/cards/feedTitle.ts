import type { FeedItem } from "../types";

const RECOMMENDED_TITLE_LENGTH = 25;
const SAFE_DERIVED_TITLE_LENGTH = 32;

export interface FeedTitlePresentation {
  text: string;
  shortened: boolean;
  needsDisclosure: boolean;
  source: "shortTitle" | "headline" | "derived" | "original";
}

const compact = (value: string) => value.replace(/\s+/g, " ").trim();
const lengthOf = (value: string) => Array.from(value).length;

const CHINESE_FUNCTION_NOUN =
  /(?:插件|引擎|框架|工具|系统|组件|助手|服务|应用|模型|记忆|知识库|工作台|看板)$/u;
const ENGLISH_FUNCTION_NOUN =
  /(?:memory|engine|plugin|framework|tool|assistant|service|system|extension)$/i;

function escaped(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function stripSiteShell(title: string, source: string): string {
  let next = title;
  const labels = [source, "GitHub"].map(compact).filter((label) => label.length >= 3);
  for (const label of labels) {
    const token = escaped(label);
    next = next
      .replace(new RegExp(`^${token}\\s*[-–—|:：]\\s*`, "i"), "")
      .replace(new RegExp(`\\s*[-–—|·]\\s*${token}$`, "i"), "");
  }
  return compact(next);
}

function stripRepeatedGithubTail(title: string): string {
  const repeatedTail = title.match(
    /\s+[·|]\s*GitHub(?:\s*[-–—|:：]\s*.*)?$/i,
  );
  if (repeatedTail?.index !== undefined) {
    return compact(title.slice(0, repeatedTail.index));
  }
  const doubledTail = title.match(
    /\s+[-–—]\s*GitHub\s*[-–—|:：]\s*GitHub\s*[-–—|:：]/i,
  );
  return doubledTail?.index !== undefined
    ? compact(title.slice(0, doubledTail.index))
    : title;
}

function repositoryFromGithubTitle(title: string): string | undefined {
  const expression =
    /(?:GitHub\s*[-–—|:：]\s*)+(?:https?:\/\/github\.com\/)?([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)/gi;
  let repository: string | undefined;
  let match: RegExpExecArray | null;
  while ((match = expression.exec(title)) !== null) repository = match[1];
  return repository;
}

function projectName(repository: string): string {
  const parts = repository.split("/");
  const raw = compact(parts[parts.length - 1] || repository)
    .replace(/\.git$/i, "")
    .replace(/[-_]+/g, " ");
  return raw
    .split(" ")
    .filter(Boolean)
    .map((part) => {
      if (/^[A-Z0-9]{2,}$/.test(part)) return part;
      if (/^[a-z0-9]{1,3}$/.test(part)) return part.toUpperCase();
      return `${part.charAt(0).toUpperCase()}${part.slice(1)}`;
    })
    .join(" ");
}

function hasSensitiveConstruction(value: string): boolean {
  // 引语、否定和转折经常把结论放在后半句；机械截掉会反转原意。
  return /[“”‘’"']/.test(value) || /(?:并?未|不是|不会|没有|否认|停止|下降|但|然而|却)/.test(value);
}

function firstSafeClause(
  value: string,
  minimumLength = 8,
  maximumLength = SAFE_DERIVED_TITLE_LENGTH,
  colonIsBoundary = false,
): string | undefined {
  if (hasSensitiveConstruction(value)) return;
  const characters = Array.from(value);
  let quote: string | undefined;
  for (let index = 0; index < characters.length; index += 1) {
    const character = characters[index];
    if (["“", "‘", '"', "'"].includes(character)) {
      quote = character;
      continue;
    }
    if ((character === "”" && quote === "“") || (character === "’" && quote === "‘") || character === quote) {
      quote = undefined;
      continue;
    }
    if (quote) continue;
    const majorBoundary = /[。；！？!?]/.test(character) ||
      (colonIsBoundary && character === "：") ||
      (character === "." && /\s/.test(characters[index + 1] ?? ""));
    const commaBoundary = /[，,]/.test(character);
    if (!majorBoundary && !commaBoundary) continue;
    const candidate = compact(characters.slice(0, index).join(""));
    const rest = compact(characters.slice(index + 1).join(""));
    if (lengthOf(candidate) < minimumLength) continue;
    if (commaBoundary && (/^(?:但|然而|却|仍|并|未|不|同时)/.test(rest) || lengthOf(candidate) < 12)) {
      continue;
    }
    if (lengthOf(candidate) <= maximumLength) return candidate;
  }
}

function namedDescription(title: string): { name: string; description: string } | undefined {
  const repository = title.match(/^([^\s:：]+\/[^\s:：]+)\s*[:：]\s*(.+)$/);
  if (repository) return { name: repository[1], description: repository[2] };

  const colon = title.match(/^(.{1,40}?)\s*[:：]\s*(.+)$/u);
  if (colon && !/[。；！？!?]/u.test(colon[1])) {
    return { name: colon[1], description: colon[2] };
  }

  const dash = title.match(
    /^([A-Za-z0-9][A-Za-z0-9._+#/]*(?:\s+[A-Za-z0-9][A-Za-z0-9._+#/]*){0,4})\s+[—–-]\s+(.+)$/u,
  );
  return dash ? { name: dash[1], description: dash[2] } : undefined;
}

function stripExplicitPlatformModifier(value: string): string {
  const next = compact(value);
  const firstChinese = next.search(/[\u3400-\u9fff]/u);
  if (firstChinese > 0) {
    const prefix = next.slice(0, firstChinese);
    const functionalPhrase = next.slice(firstChinese);
    const clearlySeparated = /\s$/u.test(prefix) || /[、，,]/u.test(prefix);
    if (
      clearlySeparated &&
      /[A-Za-z]/u.test(prefix) &&
      CHINESE_FUNCTION_NOUN.test(functionalPhrase)
    ) {
      return functionalPhrase;
    }
  }

  const withoutTerminal = next.replace(/[。.!]+$/u, "");
  const englishPlatform = withoutTerminal.match(/^(.+?)\s+for\s+(.+)$/i);
  if (
    englishPlatform &&
    ENGLISH_FUNCTION_NOUN.test(compact(englishPlatform[1])) &&
    /^(?:[A-Z][A-Za-z0-9._+#/-]*)(?:\s+[A-Z][A-Za-z0-9._+#/-]*){0,4}$/u
      .test(compact(englishPlatform[2]))
  ) {
    return compact(englishPlatform[1]);
  }
  return withoutTerminal;
}

function deriveGithubTitle(title: string, repository?: string): string | undefined {
  const named = namedDescription(title);
  if (!named) return repository ? projectName(repository) : undefined;
  const name = repository
    ? projectName(repository)
    : named.name.includes("/")
      ? projectName(named.name)
      : compact(named.name);
  const description = compact(named.description);
  if (!name) return;
  const wholeDescription = stripExplicitPlatformModifier(description);
  const whole = `${name}：${wholeDescription}`;
  if (lengthOf(whole) <= RECOMMENDED_TITLE_LENGTH) return whole;

  if (!/[\u3400-\u9fff]/u.test(description)) {
    const descriptionLead = firstSafeClause(description, 4, 96, true);
    const reduced = descriptionLead
      ? stripExplicitPlatformModifier(descriptionLead)
      : wholeDescription;
    const combined = `${name}：${reduced}`;
    return (reduced !== description && lengthOf(combined) <= SAFE_DERIVED_TITLE_LENGTH)
      ? combined
      : name;
  }

  const descriptionLead = firstSafeClause(description, 4, 96, true);
  if (!descriptionLead) return whole;
  const combined = `${name}：${stripExplicitPlatformModifier(descriptionLead)}`;
  return lengthOf(combined) <= SAFE_DERIVED_TITLE_LENGTH
    ? combined
    : whole;
}

/**
 * 只在标题结构明确时提炼；原 title 始终保留给悬停与展开态。
 * 无完整语义边界的长标题交给两行省略，不机械切字。
 */
export function presentFeedTitle(
  item: Pick<FeedItem, "title" | "shortTitle" | "headline" | "source">
): FeedTitlePresentation {
  const original = compact(item.title);
  const explicitShortTitle = compact(item.shortTitle ?? "");
  const explicitHeadline = compact(item.headline ?? "");
  const explicit = explicitShortTitle || explicitHeadline;
  if (explicit) {
    return {
      text: explicit,
      shortened: explicit !== original,
      needsDisclosure: explicit !== original || lengthOf(original) > RECOMMENDED_TITLE_LENGTH,
      source: explicitShortTitle ? "shortTitle" : "headline"
    };
  }

  const repository = repositoryFromGithubTitle(original);
  const withoutRepeatedTail = stripRepeatedGithubTail(original);
  const withoutShell = stripSiteShell(withoutRepeatedTail, item.source);
  const github = /github/i.test(item.source) || /\bgithub\b/i.test(original);
  const githubTitle = github ? deriveGithubTitle(withoutShell, repository) : undefined;
  const safeClause = !githubTitle && lengthOf(withoutShell) > RECOMMENDED_TITLE_LENGTH
    ? firstSafeClause(withoutShell)
    : undefined;
  const text = githubTitle || safeClause || withoutShell || original;
  const shortened = text !== original;
  return {
    text,
    shortened,
    needsDisclosure: shortened || lengthOf(original) > RECOMMENDED_TITLE_LENGTH,
    source: shortened ? "derived" : "original"
  };
}
