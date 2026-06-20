const htmlMinifier = require("html-minifier-terser");
const lightningcss = require("lightningcss");
const { HtmlBasePlugin } = require("@11ty/eleventy");

module.exports = function (eleventyConfig) {
  const isProduction = process.env.NODE_ENV === "production";

  eleventyConfig.addPlugin(HtmlBasePlugin);

  // Passthrough copy
  eleventyConfig.addPassthroughCopy("src/assets");
  // Standalone interactive Sleep Assessment (self-contained HTML+JS, served verbatim)
  // ignore as a template input so Liquid never touches the inline JS; copy it as-is
  eleventyConfig.ignores.add("src/sleep-assessment/**");
  eleventyConfig.addPassthroughCopy("src/sleep-assessment");
  // Standalone app-style Sleep Diary (self-contained HTML+JS, served verbatim)
  eleventyConfig.ignores.add("src/diary/**");
  eleventyConfig.addPassthroughCopy("src/diary");

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
