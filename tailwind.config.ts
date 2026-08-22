import type { Config } from "tailwindcss";

/**
 * Tailwind 配置
 * 颜色都用 `rgb(var(--xxx) / <alpha-value>)` 形式,
 * 这样 `bg-zinc-900/50` `text-indigo-400/80` 这种透明度修饰符才能工作。
 */

const rgbVar = (token: string) => `rgb(var(${token}) / <alpha-value>)`;

const config: Config = {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  darkMode: "class",
  theme: {
    extend: {
      colors: {
        // 语义层(根据 light/dark 自动切换)
        bg: rgbVar("--bg"),
        "bg-elevated": rgbVar("--bg-elevated"),
        "bg-muted": rgbVar("--bg-muted"),
        border: rgbVar("--border"),
        "border-strong": rgbVar("--border-strong"),
        text: rgbVar("--text"),
        "text-muted": rgbVar("--text-muted"),
        "text-faint": rgbVar("--text-faint"),
        accent: rgbVar("--accent"),
        success: rgbVar("--success"),
        warning: rgbVar("--warning"),
        danger: rgbVar("--danger"),

        // 调色盘(latitude 大量直接用 zinc-XXX/indigo-XXX)
        zinc: {
          50: rgbVar("--zinc-50"),
          100: rgbVar("--zinc-100"),
          200: rgbVar("--zinc-200"),
          300: rgbVar("--zinc-300"),
          400: rgbVar("--zinc-400"),
          500: rgbVar("--zinc-500"),
          600: rgbVar("--zinc-600"),
          700: rgbVar("--zinc-700"),
          800: rgbVar("--zinc-800"),
          900: rgbVar("--zinc-900"),
          950: rgbVar("--zinc-950")
        },
        indigo: {
          50: rgbVar("--indigo-50"),
          100: rgbVar("--indigo-100"),
          300: rgbVar("--indigo-300"),
          400: rgbVar("--indigo-400"),
          500: rgbVar("--indigo-500"),
          600: rgbVar("--indigo-600"),
          700: rgbVar("--indigo-700")
        },
        emerald: {
          50: rgbVar("--emerald-50"),
          100: rgbVar("--emerald-100"),
          200: rgbVar("--emerald-200"),
          400: rgbVar("--emerald-400"),
          500: rgbVar("--emerald-500"),
          600: rgbVar("--emerald-600"),
          700: rgbVar("--emerald-700"),
          900: rgbVar("--emerald-900"),
          950: rgbVar("--emerald-950")
        },
        amber: {
          50: rgbVar("--amber-50"),
          100: rgbVar("--amber-100"),
          200: rgbVar("--amber-200"),
          300: rgbVar("--amber-300"),
          400: rgbVar("--amber-400"),
          500: rgbVar("--amber-500"),
          700: rgbVar("--amber-700"),
          800: rgbVar("--amber-800"),
          900: rgbVar("--amber-900"),
          950: rgbVar("--amber-950")
        },
        red: {
          50: rgbVar("--red-50"),
          400: rgbVar("--red-400"),
          500: rgbVar("--red-500"),
          600: rgbVar("--red-600"),
          950: rgbVar("--red-950")
        }
      },
      fontFamily: {
        sans: ["var(--font-sans)"],
        mono: ["var(--font-mono)"]
      },
      fontSize: {
        xs: "var(--text-xs)",
        sm: "var(--text-sm)",
        base: "var(--text-base)",
        md: "var(--text-md)",
        lg: "var(--text-lg)",
        xl: "var(--text-xl)",
        "2xl": "var(--text-2xl)",
        "3xl": "var(--text-3xl)"
      },
      borderRadius: {
        sm: "var(--radius-sm)",
        md: "var(--radius-md)",
        lg: "var(--radius-lg)",
        xl: "var(--radius-xl)",
        "2xl": "var(--radius-2xl)",
        full: "var(--radius-full)"
      },
      boxShadow: {
        sm: "var(--shadow-sm)",
        md: "var(--shadow-md)",
        lg: "var(--shadow-lg)"
      },
      transitionDuration: {
        fast: "var(--motion-fast)",
        base: "var(--motion-base)",
        slow: "var(--motion-slow)"
      },
      transitionTimingFunction: {
        spring: "var(--motion-spring)"
      }
    }
  },
  plugins: []
};

export default config;
