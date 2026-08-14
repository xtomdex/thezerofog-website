const crypto = require("crypto");
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
  // Standalone workshop text-version long-read (self-contained HTML, served verbatim, noindex)
  eleventyConfig.ignores.add("src/workshop-text/**");
  eleventyConfig.addPassthroughCopy("src/workshop-text");
  // Workshop bonus guides (self-contained HTML + PDFs, served verbatim)
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

  // Cache-busting for /assets/*.
  //
  // netlify.toml caches /assets/* for a year with `immutable`, which tells the browser never to
  // revalidate - not even on an ordinary reload. That is only honest when the URL changes with
  // the content, and our asset filenames never did. The consequence was that every CSS and JS
  // fix was invisible to anyone who had visited the site before, for up to a year. Measured on
  // 2026-08-14: a deployed stylesheet fix did not reach the page until a hard reload.
  //
  // `| v` appends a short hash of the file's own bytes, so a changed file gets a new URL and the
  // long cache becomes correct rather than harmful. Hashes come from the source file: the only
  // thing that matters is that the query changes when the source does.
  //
  // Note this covers what templates reference. Images referenced from inside CSS (the replay
  // poster, for one) cannot be rewritten this way, which is why /assets/img keeps a short cache
  // in netlify.toml rather than an immutable one.
  const assetHashes = new Map();
  function assetVersion(assetPath) {
    if (typeof assetPath !== "string" || !assetPath.startsWith("/assets/")) return assetPath;
    if (assetHashes.has(assetPath)) return assetHashes.get(assetPath);

    const filePath = path.join(__dirname, "src", assetPath);
    let result = assetPath;
    try {
      const hash = crypto
        .createHash("md5")
        .update(fs.readFileSync(filePath))
        .digest("hex")
        .slice(0, 8);
      result = `${assetPath}?v=${hash}`;
    } catch {
      // A missing file is a broken reference, and a build is the right place to hear about it.
      // It must not be the place the site stops being built, though - the page would lose its
      // styles entirely, which is worse than a stale cache.
      console.warn(`[asset hash] not found, left unversioned: ${assetPath}`);
    }

    assetHashes.set(assetPath, result);
    return result;
  }
  eleventyConfig.addFilter("v", assetVersion);

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

    // dist/zf-env.js — tracking config for passthrough pages (/workshop-text/),
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

    // The pages served verbatim - /workshop-text/, /app/, the bonus guides - never pass through
    // a template, so the `| v` filter cannot reach them. They still link the shared stylesheet
    // and scripts, and without a version those three references would keep a returning visitor
    // on a year-old copy while every other page moved on. Same hash, applied to the built HTML.
    const htmlFiles = [];
    (function collect(dir) {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) collect(full);
        else if (entry.name.endsWith(".html")) htmlFiles.push(full);
      }
    })(path.join(__dirname, "dist"));

    let patched = 0;
    for (const file of htmlFiles) {
      const before = fs.readFileSync(file, "utf8");
      const after = before.replace(
        /(href|src)="(\/assets\/(?:css|js)\/[^"?]+)"/g,
        (whole, attr, assetPath) => {
          const versioned = assetVersion(assetPath);
          return versioned === assetPath ? whole : `${attr}="${versioned}"`;
        }
      );
      if (after !== before) {
        fs.writeFileSync(file, after);
        patched += 1;
      }
    }
    if (patched) console.log(`[asset hash] versioned assets in ${patched} passthrough page(s)`);
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
