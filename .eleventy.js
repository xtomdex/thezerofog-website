const fs = require("fs");
const path = require("path");
const htmlMinifier = require("html-minifier-terser");
const lightningcss = require("lightningcss");
const { HtmlBasePlugin } = require("@11ty/eleventy");

module.exports = function (eleventyConfig) {
  const isProduction = process.env.NODE_ENV === "production";

  eleventyConfig.addPlugin(HtmlBasePlugin);

  // Passthrough copy
  eleventyConfig.addPassthroughCopy("src/assets");
  // Standalone webinar text-version long-read (self-contained HTML, served verbatim, noindex)
  eleventyConfig.ignores.add("src/webinar-text/**");
  eleventyConfig.addPassthroughCopy("src/webinar-text");
  // Webinar bonus guides (self-contained HTML + PDFs, served verbatim)
  eleventyConfig.ignores.add("src/bonuses/**");
  eleventyConfig.addPassthroughCopy("src/bonuses");
  // Combined webinar bonuses page (self-contained HTML+JS, served verbatim, noindex)
  eleventyConfig.ignores.add("src/webinar-bonuses/**");
  eleventyConfig.addPassthroughCopy("src/webinar-bonuses");

  // Shared no-build JS modules (e.g. recovery tracker) served verbatim at /shared/*
  eleventyConfig.addPassthroughCopy("src/shared");

  // Combined /app (Sleep Diary + Assessment, auth + PWA, self-contained, served verbatim)
  eleventyConfig.ignores.add("src/app/**");
  eleventyConfig.addPassthroughCopy("src/app");

  // Internal design prototypes (desktop sidebar app + mobile iframe preview), noindex, not linked anywhere
  eleventyConfig.ignores.add("src/mockups/**");
  eleventyConfig.addPassthroughCopy("src/mockups");

  // Downloadable course materials (PDFs) served verbatim
  eleventyConfig.addPassthroughCopy("src/downloads");

  // CSS processing via lightningcss
  eleventyConfig.addTemplateFormats("css");
  eleventyConfig.addExtension("css", {
    outputFileExtension: "css",
    compile: async function (inputContent, inputPath) {
      if (!inputPath.includes("src/assets")) return;
      return async () => {
        const { code } = lightningcss.transform({
          filename: inputPath,
          code: Buffer.from(inputContent),
          minify: isProduction,
          sourceMap: false,
        });
        return code.toString();
      };
    },
  });

  // Generate dist/app/config.js from public Supabase env at build time.
  // The /app page is served verbatim (passthrough), so it can't read env via the
  // {{ env.* }} Nunjucks partial. Instead we emit a tiny file exposing the two
  // PUBLIC values as window.* globals, which /app/index.html loads via <script src>.
  // The anon key is public by design — RLS protects the data.
  eleventyConfig.on("eleventy.after", () => {
    const outDir = path.join(__dirname, "dist", "app");
    fs.mkdirSync(outDir, { recursive: true });

    const url = process.env.SUPABASE_URL || "";
    const anonKey = process.env.SUPABASE_ANON_KEY || "";

    if (!url) {
      console.warn("[config.js] SUPABASE_URL is not set — /app auth will not work");
    }
    if (!anonKey) {
      console.warn("[config.js] SUPABASE_ANON_KEY is not set — /app auth will not work");
    }

    const contents =
      "// GENERATED at build time from env — do not edit.\n" +
      "// Public, non-secret client config. The anon key is public by design; RLS protects the data.\n" +
      `window.ZF_SUPABASE_URL = ${JSON.stringify(url)};\n` +
      `window.ZF_SUPABASE_ANON_KEY = ${JSON.stringify(anonKey)};\n`;

    fs.writeFileSync(path.join(outDir, "config.js"), contents);

    // dist/zf-env.js — tracking config for passthrough pages (/webinar-text/),
    // which can't read env via the pixel-meta.njk partial. Same globals, same
    // consent gate (cookie-consent-2.js loads nothing before consent === 'all').
    // Lives at the site root, NOT under /assets/ — /assets/* is cached immutable
    // for a year, and this file's contents change with env, not with a rename.
    const pixelId = process.env.META_PIXEL_ID || "";
    const posthogKey = process.env.PUBLIC_POSTHOG_KEY || "";
    const posthogHost = process.env.PUBLIC_POSTHOG_HOST || "https://us.i.posthog.com";
    const envContents =
      "// GENERATED at build time from env — do not edit.\n" +
      "// Public, non-secret tracking config. Trackers are consent-gated in cookie-consent-2.js.\n" +
      (pixelId ? `window.ZF_META_PIXEL_ID = ${JSON.stringify(pixelId)};\n` : "") +
      (posthogKey
        ? `window.ZF_POSTHOG_KEY = ${JSON.stringify(posthogKey)};\n` +
          `window.ZF_POSTHOG_HOST = ${JSON.stringify(posthogHost)};\n`
        : "");
    fs.writeFileSync(path.join(__dirname, "dist", "zf-env.js"), envContents);
  });

  // HTML minification in production
  if (isProduction) {
    eleventyConfig.addTransform("htmlmin", async function (content) {
      if ((this.page.outputPath || "").endsWith(".html")) {
        return await htmlMinifier.minify(content, {
          removeComments: true,
          collapseWhitespace: true,
          minifyCSS: true,
          minifyJS: true,
        });
      }
      return content;
    });
  }

  return {
    dir: {
      input: "src",
      output: "dist",
    },
    templateFormats: ["njk", "md", "html"],
  };
};
