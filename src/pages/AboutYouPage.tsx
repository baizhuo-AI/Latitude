import { useTranslation } from "react-i18next";
import { UserCircle2, Brain } from "lucide-react";
import { Section } from "../components/settings/SettingsPrimitives";
import { PersonaPanel } from "../components/persona/PersonaPanel";
import { AboutYouPanel } from "../components/memory/AboutYouPanel";

/**
 * 「关于你」页(需求 2)— 从设置页拆出的一级导航入口。
 *
 * 主题:让 AI 认识你、记住你。
 *  - AI 人设(PersonaPanel):AI 是谁、怎么称呼你、习惯与雷区
 *  - 关于你的记忆(AboutYouPanel):AI 记住的长期事实,可查看 / 编辑 / 删除
 *
 * 边界:主动提醒(proactive)与隐私 / 成本(privacy)是「行为 / 隐私设置」,
 * 语义上不属于「你是谁」,仍留在设置页。如需收进来,把对应 Section 平移即可。
 */
export function AboutYouPage() {
  const { t } = useTranslation();
  return (
    <div className="h-full flex flex-col">
      <header className="h-14 px-6 flex items-center border-b border-zinc-200 dark:border-zinc-800 flex-shrink-0">
        <h1 className="text-lg font-semibold tracking-tight text-zinc-900 dark:text-zinc-100">
          {t("nav.aboutYou")}
        </h1>
      </header>

      <div className="flex-1 overflow-auto scrollbar-thin">
        <div className="max-w-2xl mx-auto px-6 py-8 space-y-8">
          {/* AI 人设 */}
          <Section
            icon={<UserCircle2 className="w-4 h-4" />}
            title={t("persona.sectionTitle")}
            description={t("persona.sectionDesc")}
          >
            <PersonaPanel />
          </Section>

          {/* 关于你(记忆事实面板) */}
          <Section
            icon={<Brain className="w-4 h-4" />}
            title={t("memory.sectionTitle")}
            description={t("memory.sectionDesc")}
          >
            <AboutYouPanel />
          </Section>
        </div>
      </div>
    </div>
  );
}
