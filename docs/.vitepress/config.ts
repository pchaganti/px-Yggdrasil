import { defineConfig } from "vitepress";

export default defineConfig({
  base: "/Yggdrasil/",
  title: "Yggdrasil",
  description: "Continuous architecture enforcement for AI-assisted development",
  vite: {
    build: {
      // esbuild is force-upgraded to >= 0.28.1 via an npm `overrides` entry to patch two
      // security advisories. esbuild 0.28 refuses to down-level modern syntax (e.g.
      // destructuring) to Vite 5.4's default browser target (chrome87/es2020), failing the
      // build. Raise the target to es2022 so no down-level transform is attempted. Trade-off:
      // the generated docs site requires a reasonably modern browser (≈2022+).
      target: "es2022",
    },
  },
  themeConfig: {
    logo: "/logo.svg",
    nav: [
      { text: "Home", link: "/" },
      { text: "Getting Started", link: "/getting-started" },
      { text: "GitHub", link: "https://github.com/krzysztofdudek/Yggdrasil" },
    ],
    sidebar: [
      { text: "Home", link: "/" },
      { text: "Getting Started", link: "/getting-started" },
      { text: "Core Concepts", link: "/core-concepts" },
      { text: "Supported Platforms", link: "/platforms" },
      { text: "CLI Reference", link: "/cli-reference" },
      { text: "Configuration", link: "/configuration" },
      { text: "Reviewers", link: "/reviewers" },
      { text: "Aspect Status", link: "/aspect-status" },
      { text: "Conditional Aspects", link: "/conditional-aspects" },
      { text: "Dogfood Showcase", link: "/showcase" },
    ],
  },
});
