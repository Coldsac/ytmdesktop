import type { ForgeConfig } from '@electron-forge/shared-types';
import { MakerSquirrel } from '@electron-forge/maker-squirrel';
import { MakerZIP } from '@electron-forge/maker-zip';
import { MakerDeb } from '@electron-forge/maker-deb';
import { MakerRpm } from '@electron-forge/maker-rpm';
import { VitePlugin } from '@electron-forge/plugin-vite';
import { FusesPlugin } from '@electron-forge/plugin-fuses';
import { FuseV1Options, FuseVersion } from '@electron/fuses';
import { createRequire } from "node:module";
import { existsSync, readFileSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";

const require = createRequire(__filename);

function packageDirectory(name: string): string | null {
  const directManifest = path.join(__dirname, "node_modules", name, "package.json");
  if (existsSync(directManifest)) {
    const manifest = JSON.parse(readFileSync(directManifest, "utf8")) as { name?: string };
    if (manifest.name === name) return path.dirname(directManifest);
  }

  try {
    let dir = path.dirname(require.resolve(name));
    while (true) {
      const manifestPath = path.join(dir, "package.json");
      if (existsSync(manifestPath)) {
        const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as { name?: string };
        if (manifest.name === name) return dir;
      }
      const parent = path.dirname(dir);
      if (parent === dir) return null;
      dir = parent;
    }
  } catch {
    return null;
  }
}

function collectRuntimePackages(roots: string[]): Map<string, string> {
  const found = new Map<string, string>();
  const queue = [...roots];
  while (queue.length > 0) {
    const name = queue.pop();
    if (!name || name.startsWith("@types/") || found.has(name)) continue;

    const dir = packageDirectory(name);
    if (!dir) continue;
    found.set(name, dir);

    const manifest = JSON.parse(readFileSync(path.join(dir, "package.json"), "utf8")) as {
      dependencies?: Record<string, string>;
      optionalDependencies?: Record<string, string>;
      peerDependencies?: Record<string, string>;
    };
    const deps = {
      ...manifest.dependencies,
      ...manifest.optionalDependencies,
      ...manifest.peerDependencies
    };
    queue.push(...Object.keys(deps));
  }
  return found;
}

const config: ForgeConfig = {
  packagerConfig: {
    executableName: "youtube-music-desktop-app",
    icon: "src/assets/icons/ytmd",
    extraResource: [
      "src/assets/icons/tray.ico",
      "src/assets/icons/trayTemplate.png",
      "src/assets/icons/trayTemplate@2x.png",
      "src/assets/icons/ytmd.png",
      "src/assets/icons/ytmd_white.png",
      "src/assets/icons/ytmd_black.png",

      "src/assets/icons/controls/pause-button.png",
      "src/assets/icons/controls/play-button.png",
      "src/assets/icons/controls/play-next-button.png",
      "src/assets/icons/controls/play-previous-button.png",
    ],
    protocols: [
      {
        name: "YTMDesktop",
        schemes: ["ytmd"]
      }
    ],
    appCategoryType: "public.app-category.music",
    asar: {
      unpack: "**/*.{node,dll}"
    }
  },
  rebuildConfig: {},
  makers: [
    new MakerSquirrel({
      iconUrl: `https://raw.githubusercontent.com/ytmdesktop/ytmdesktop/137c4e5c175c8c125cbcca9a5312611f80cd3bd9/src/assets/icons/ytmd.ico`
    }),
    new MakerZIP({}, ['darwin']),
    new MakerRpm({
      options: {
        categories: ["AudioVideo", "Audio"],
        mimeType: ["x-scheme-handler/ytmd"],
        icon: "src/assets/icons/ytmd.png"
      }
    }),
    new MakerDeb({
      options: {
        categories: ["AudioVideo", "Audio"],
        mimeType: ["x-scheme-handler/ytmd"],
        section: "sound",
        icon: "src/assets/icons/ytmd.png"
      }
    }),
  ],
  publishers: [
    {
      name: "@electron-forge/publisher-github",
      config: {
        repository: {
          owner: process.env.YTMD_UPDATE_FEED_OWNER,
          name: process.env.YTMD_UPDATE_FEED_REPOSITORY
        }
      }
    }
  ],
  plugins: [
    new VitePlugin({
      build: [
        {
          entry: "src/main/index.ts",
          config: "config/vite/main.ts",
          target: "main",
        },
        {
          entry: "src/renderer/windows/main/preload.ts",
          config: "config/vite/preload/main_window.ts",
          target: "preload"
        },
        {
          entry: "src/renderer/windows/settings/preload.ts",
          config: "config/vite/preload/settings_window.ts",
          target: "preload"
        },
        {
          entry: "src/renderer/windows/authorize-companion/preload.ts",
          config: "config/vite/preload/authorize_companion_window.ts",
          target: "preload"
        },
        {
          entry: "src/renderer/windows/titlebar/preload.ts",
          config: "config/vite/preload/titlebar_window.ts",
          target: "preload"
        },
        {
          entry: "src/renderer/windows/updater/preload.ts",
          config: "config/vite/preload/updater_window.ts",
          target: "preload"
        },
        {
          entry: "src/renderer/windows/miniplayer/preload.ts",
          config: "config/vite/preload/miniplayer_window.ts",
          target: "preload"
        },
        {
          entry: "src/renderer/windows/changelog/preload.ts",
          config: "config/vite/preload/changelog_window.ts",
          target: "preload"
        },
        {
          entry: "src/renderer/ytmview/preload.ts",
          config: "config/vite/preload/ytmview.ts",
          target: "preload"
        },
        {
          entry: "src/renderer/windows/discord-voice/preload.ts",
          config: "config/vite/preload/discord_voice_window.ts",
          target: "preload"
        }
      ],
      renderer: [
        {
          name: "all_windows",
          config: "config/vite/renderer.ts",
        },
      ],
    }),
    new FusesPlugin({
      version: FuseVersion.V1,
      strictlyRequireAllFuses: true,
      [FuseV1Options.RunAsNode]: false,
      [FuseV1Options.EnableCookieEncryption]: true,
      [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,
      [FuseV1Options.EnableNodeCliInspectArguments]: false,
      [FuseV1Options.EnableEmbeddedAsarIntegrityValidation]: true,
      [FuseV1Options.OnlyLoadAppFromAsar]: true,
      [FuseV1Options.GrantFileProtocolExtraPrivileges]: false,
      [FuseV1Options.WasmTrapHandlers]: true,
      [FuseV1Options.LoadBrowserProcessSpecificV8Snapshot]: false
    }),
  ],
  hooks: {
    async packageAfterCopy(_config, buildPath, _electronVersion, platform, arch) {
      const srcRoot = path.join(__dirname, "node_modules");
      const destRoot = path.join(buildPath, "node_modules");
      
      const xosmsPlatformSuffix = (() => {
        switch (platform) {
          case "linux":
            return "-gnu"
          case "win32":
            return "-msvc"
          default:
            return ""
        }
      })()
      const daveyPlatform = (() => {
        if (platform === "win32" && arch === "x64") return "@snazzah/davey-win32-x64-msvc";
        if (platform === "win32" && arch === "arm64") return "@snazzah/davey-win32-arm64-msvc";
        if (platform === "win32" && arch === "ia32") return "@snazzah/davey-win32-ia32-msvc";
        if (platform === "darwin" && arch === "arm64") return "@snazzah/davey-darwin-arm64";
        if (platform === "darwin") return "@snazzah/davey-darwin-x64";
        if (platform === "linux" && arch === "arm64") return "@snazzah/davey-linux-arm64-gnu";
        if (platform === "linux") return "@snazzah/davey-linux-x64-gnu";
        return null;
      })();
      const roots = [
        "xosms",
        `@xosms/xosms-${platform}-${arch}${xosmsPlatformSuffix}`,
        "discord.js",
        "@discordjs/voice",
        "opusscript",
        "libsodium-wrappers",
        "@snazzah/davey",
        daveyPlatform
      ].filter((pkg): pkg is string => pkg !== null);
      const packages = collectRuntimePackages(roots);
      console.log(`Copying ${packages.size} runtime packages into the app`);

      await Promise.all(
        [...packages.entries()].map(async ([pkg, src]) => {
          const dest = path.join(destRoot, pkg);
          await fs.cp(src, dest, {
            dereference: true,
            recursive: true,
            filter: source => !path.relative(src, source).split(path.sep).includes("node_modules")
          });
        })
      );

      void srcRoot;
    }
  }
};

export default config;
