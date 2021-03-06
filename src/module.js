/* eslint-disable import/no-extraneous-dependencies */
import { join } from "path";

/* covered by nuxt */
import { move } from "fs-extra";
import _ from "lodash";
import { Utils } from "nuxt";
import chokidar from "chokidar";
import pify from "pify";
import webpack from "webpack";
import webpackDevMiddleware from "webpack-dev-middleware";
import webpackHotMiddleware from "webpack-hot-middleware";
import serveStatic from "serve-static";
import Debug from "debug";

import pkg from "../package.json";

import ConfigManager from "./configManager";
import getWebpackNetlifyConfig from "./webpack.config";
import { toYAML } from "./utils/yaml";

const debug = Debug("nuxt:netlify-cms");

const WEBPACK_CLIENT_COMPILER_NAME = "client";
const WEBPACK_NETLIFY_COMPILER_NAME = "netlify-cms";
const NETLIFY_CONFIG_FILE_NAME = "config.yml";

export default function NetlifyCmsModule(moduleOptions) {
  const configManager = new ConfigManager(this.options, moduleOptions);
  const config = configManager.config;

  // This will be called once when builder started
  this.nuxt.hook("build", builder => {
    // This will be run just before webpack compiler starts
    builder.plugin("compile", ({ builder, compiler }) => {
      const webpackConfig = getWebpackNetlifyConfig(
        WEBPACK_NETLIFY_COMPILER_NAME,
        this.options,
        config
      );

      webpackConfig.plugins.push({
        apply(compiler) {
          compiler.plugin("emit", (compilation, cb) => {
            const netlifyConfigYAML = toYAML(configManager.cmsConfig);
            compilation.assets[NETLIFY_CONFIG_FILE_NAME] = {
              source: () => netlifyConfigYAML,
              size: () => netlifyConfigYAML.length
            };
            cb();
          });
        }
      });

      const netlifyCompiler = webpack(webpackConfig);

      // Only add the compiler in production,
      // in dev watch will be started by dev-middleware
      if (!this.options.dev) {
        compiler.compilers.push(netlifyCompiler);
        compiler[netlifyCompiler.name] = netlifyCompiler;
      }

      // Use shared filesystem and cache
      const clientCompiler = compiler[WEBPACK_CLIENT_COMPILER_NAME];
      netlifyCompiler.outputFileSystem = clientCompiler.outputFileSystem;
      netlifyCompiler.cache = clientCompiler.cache;

      // This will be run just after webpack compiler ends
      netlifyCompiler.plugin("done", async stats => {
        // Don't reload failed builds
        if (stats.hasErrors()) {
          return;
        }
        debug(`Bundle built!`);
      });

      // in development
      if (this.options.dev) {
        // Show a message inside console when the build is ready
        builder.plugin("compiled", async () => {
          debug(`Serving on: ${config.adminPath}`);
        });

        // Create webpack dev middleware
        const netlifyWebpackDevMiddleware = pify(
          webpackDevMiddleware(netlifyCompiler, {
            publicPath: "/",
            stats: builder.webpackStats,
            noInfo: true,
            quiet: true,
            watchOptions: this.options.watchers.webpack
          })
        );

        // Create webpack hot middleware
        const netlifyWebpackHotMiddleware = pify(
          webpackHotMiddleware(netlifyCompiler, {
            log: false,
            heartbeat: 1000
          })
        );

        // Inject to renderer instance
        if (builder.nuxt.renderer) {
          builder.nuxt.renderer.netlifyWebpackDevMiddleware = netlifyWebpackDevMiddleware;
          builder.nuxt.renderer.netlifyWebpackHotMiddleware = netlifyWebpackHotMiddleware;
        }

        // Stop webpack middleware on nuxt.close()
        this.nuxt.hook("close", async () => {
          await this.nuxt.renderer.netlifyWebpackDevMiddleware.close();
        });
      }
    });
  });

  // Serve netlify CMS
  if (this.options.dev) {
    // Insert webpackDevMiddleware to serve netlify CMS in development
    this.addServerMiddleware({
      path: config.adminPath,
      handler: async (req, res) => {
        if (this.nuxt.renderer.netlifyWebpackDevMiddleware) {
          debug(`requesting url: ${Utils.urlJoin(config.adminPath, req.url)}`);
          await this.nuxt.renderer.netlifyWebpackDevMiddleware(req, res);
        }
        if (this.nuxt.renderer.netlifyWebpackHotMiddleware) {
          await this.nuxt.renderer.netlifyWebpackHotMiddleware(req, res);
        }
      }
    });

    // Start watching config file
    const patterns = [Utils.r(configManager.cmsConfigFileName)];

    const options = {
      ...this.options.watchers.chokidar,
      ignoreInitial: true
    };

    const refreshFiles = _.debounce(() => {
      configManager.readCmsConfigFile();
      this.nuxt.renderer.netlifyWebpackDevMiddleware.invalidate();
      this.nuxt.renderer.netlifyWebpackHotMiddleware.publish({
        action: "reload"
      });
    }, 200);

    // Watch for src Files
    const fileWatcher = chokidar
      .watch(patterns, options)
      .on("add", refreshFiles)
      .on("change", refreshFiles)
      .on("unlink", refreshFiles);

    this.nuxt.renderer.netlifyFileWatcher = fileWatcher;

    // Stop watching on nuxt.close()
    this.nuxt.hook("close", () => {
      this.nuxt.renderer.netlifyFileWatcher.close();
    });
  } else {
    // Statically serve netlify CMS (i.e. .nuxt/dist/admin/) files in production
    this.addServerMiddleware({
      path: config.adminPath,
      handler: serveStatic(config.buildDir, {
        maxAge: "1y" // 1 year in production
      })
    });
  }

  // Move cms folder from `dist/_nuxt` folder to `dist/` after nuxt generate
  this.nuxt.hook("generator", generator => {
    generator.plugin("generate", async () => {
      await move(
        join(generator.distNuxtPath, config.adminPath).replace(/\/$/, ""),
        join(generator.distPath, config.adminPath).replace(/\/$/, "")
      );
      debug("Netlify CMS files copied");
    });
  });
}

// REQUIRED if publishing as an NPM package
export { pkg as meta };
