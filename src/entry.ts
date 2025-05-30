import * as path from 'node:path';
import dedent from 'string-dedent';
import kleur from 'kleur';

import { type ConditionalExports } from './manifest';
import { type Context } from './context';
import { type Reporter } from './reporter';
import * as formatUtils from './formatUtils';
import { NanobundleError } from './errors';

export type Entry = {
  key: string;
  entryPath: string;
  minify: boolean;
  mode: undefined | 'development' | 'production';
  sourcemap: boolean;
  platform: 'neutral' | 'browser' | 'deno' | 'node';
  module: 'commonjs' | 'esmodule' | 'css' | 'dts' | 'file';
  sourceFile: string[];
  outputFile: string;
  customConditions: string[],
};

type EntryTarget = {
  key: string,
  parentKey?: string,
  entryPath: string,
  platform: Entry['platform'],
  sourcemap: Entry['sourcemap'],
  mode: Entry['mode'],
  module: Entry['module'],
  preferredModule?: 'esmodule' | 'commonjs',
  customConditions: string[],
};

interface GetEntriesFromContext {
  (props: {
    context: Context;
    reporter: Reporter;
  }): Entry[];
}
export const getEntriesFromContext: GetEntriesFromContext = ({
  context,
  reporter,
}) => {
  const defaultMinify: Entry['minify'] = false;
  const defaultMode: Entry['mode'] = undefined;
  const {
    cwd,
    rootDir,
    outDir,
    sourcemap,
    manifest,
    tsconfigPath,
    jsx,
    platform: defaultPlatform,
    module: defaultModule,
  } = context;

  const defaultPreferredModule = ({
    commonjs: 'commonjs',
    esmodule: 'esmodule',
    css: undefined,
    dts: undefined,
    file: undefined,
  } as const)[defaultModule];

  const resolvedRootDir = context.resolvePath(rootDir);
  const resolvedOutDir = context.resolvePath(outDir);

  const useJsx = jsx != null;
  const useTsSource = tsconfigPath != null;
  const useJsSource = !(useTsSource && resolvedRootDir === resolvedOutDir);

  const preserveJsx = context.jsx === 'preserve';

  const entryMap = new Map<Entry["entryPath"], Entry>();

  function addEntry(target: EntryTarget) {
    const {
      key,
      parentKey,
      sourcemap,
      entryPath,
      platform,
      module,
      mode,
      preferredModule,
      customConditions,
    } = target;

    if (!entryPath.startsWith('./')) {
      throw new NanobundleEntryError(
        Message.INVALID_PATH_KEY(key),
      );
    }

    if (entryPath.includes('*')) {
      throw new NanobundleEntryError(
        Message.SUBPATH_PATTERN(entryPath),
      );
    }

    if (module === 'dts' && !/\.d\.(c|m)?ts$/.test(entryPath)) {
      throw new NanobundleEntryError(
        Message.INVALID_DTS_FORMAT(),
      );
    }

    const entry = entryMap.get(entryPath);
    if (entry) {
      // exports should be prioritized
      if (entry.key.startsWith("exports") && !key.startsWith("exports")) {
        if (entry.platform !== platform || entry.module !== module) {
          reporter.warn(
            Message.PRECEDENSE_ENTRY(entry, target),
          );
        }
        return;
      }
      if (entry.platform !== platform || entry.module !== module) {
        let hint = '';
        if (
          (entry.key === 'main' && key === 'module') ||
          (entry.key === 'module' && key === 'main')
        ) {
          hint = dedent`
            Did you forgot to set ${formatUtils.key('type')} to ${formatUtils.literal('module')} for ESM-first approach?
          `;
        }
        if (
          entry.module === module &&
          entry.platform !== platform
        ) {
          hint = dedent`
            Did you forget to specify the Node.js version in the ${formatUtils.key('engines')} field?
            Or you may not need to specify ${formatUtils.key('require')} or ${formatUtils.key('node')} entries.
          `;
        }
        throw new NanobundleEntryError(
          Message.CONFLICT_ENTRY(entry, target, hint),
        );
      }
      return;
    }

    const sourceFileCandidates = new Set<string>();

    const resolvedOutputFile = context.resolvePath(entryPath);

    let resolvedSourceFile = resolvedOutputFile.replace(
      resolvedOutDir,
      resolvedRootDir,
    );

    const minifyPattern = /\.min(?<ext>\.(m|c)?jsx?)$/;
    const minifyMatch = resolvedSourceFile.match(minifyPattern);
    const minify = defaultMinify || Boolean(minifyMatch);
    const ext = minifyMatch?.groups?.ext;
    if (ext) {
      resolvedSourceFile = resolvedSourceFile.replace(minifyPattern, ext);
    }

    if (!/jsx?$/.test(resolvedSourceFile)) {
      switch (module) {
        case 'commonjs': {
          useTsSource && sourceFileCandidates.add(`${resolvedSourceFile}.cts`);
          useJsSource && sourceFileCandidates.add(`${resolvedSourceFile}.cjs`);
          useJsx && useTsSource && sourceFileCandidates.add(`${resolvedSourceFile}.tsx`);
          useTsSource && sourceFileCandidates.add(`${resolvedSourceFile}.ts`);
          useJsx && useJsSource && sourceFileCandidates.add(`${resolvedSourceFile}.jsx`);
          useJsSource && sourceFileCandidates.add(`${resolvedSourceFile}.js`);
          break;
        }
        case 'esmodule': {
          useTsSource && sourceFileCandidates.add(`${resolvedSourceFile}.mts`);
          useJsSource && sourceFileCandidates.add(`${resolvedSourceFile}.mjs`);
          useJsx && useTsSource && sourceFileCandidates.add(`${resolvedSourceFile}.tsx`);
          useTsSource && sourceFileCandidates.add(`${resolvedSourceFile}.ts`);
          useJsx && useJsSource && sourceFileCandidates.add(`${resolvedSourceFile}.jsx`);
          useJsSource && sourceFileCandidates.add(`${resolvedSourceFile}.js`);
          break;
        }
      }
    }

    switch (module) {
      case 'commonjs': {
        useTsSource && sourceFileCandidates.add(resolvedSourceFile.replace(/\.c?jsx?$/, '.cts'));
        useJsSource && sourceFileCandidates.add(resolvedSourceFile.replace(/\.c?jsx?$/, '.cjs'));
        useJsx && useTsSource && sourceFileCandidates.add(resolvedSourceFile.replace(/\.c?jsx?$/, '.tsx'));
        useTsSource && sourceFileCandidates.add(resolvedSourceFile.replace(/\.c?jsx?$/, '.ts'));
        useJsx && useJsSource && sourceFileCandidates.add(resolvedSourceFile.replace(/\.c?jsx?$/, '.jsx'));
        useJsSource && sourceFileCandidates.add(resolvedSourceFile.replace(/\.c?jsx?$/, '.js'));
        if (parentKey) {
          let resolvedSourceFileWithoutCondition = resolvedSourceFile.replace('.' + parentKey, '');
          useTsSource && sourceFileCandidates.add(resolvedSourceFileWithoutCondition.replace(/\.c?jsx?$/, '.cts'));
          useJsSource && sourceFileCandidates.add(resolvedSourceFileWithoutCondition.replace(/\.c?jsx?$/, '.cjs'));
          useJsx && useTsSource && sourceFileCandidates.add(resolvedSourceFileWithoutCondition.replace(/\.c?jsx?$/, '.tsx'));
          useTsSource && sourceFileCandidates.add(resolvedSourceFileWithoutCondition.replace(/\.c?jsx?$/, '.ts'));
          useJsx && useJsSource && sourceFileCandidates.add(resolvedSourceFileWithoutCondition.replace(/\.c?jsx?$/, '.jsx'));
          useJsSource && sourceFileCandidates.add(resolvedSourceFileWithoutCondition.replace(/\.c?jsx?$/, '.js'));
        }
        useJsSource && sourceFileCandidates.add(resolvedSourceFile);
        break;
      }
      case 'esmodule': {
        useTsSource && sourceFileCandidates.add(resolvedSourceFile.replace(/\.m?jsx?$/, '.mts'));
        useJsSource && sourceFileCandidates.add(resolvedSourceFile.replace(/\.m?jsx?$/, '.mjs'));
        useJsx && useTsSource && sourceFileCandidates.add(resolvedSourceFile.replace(/\.m?jsx?$/, '.tsx'));
        useTsSource && sourceFileCandidates.add(resolvedSourceFile.replace(/\.m?jsx?$/, '.ts'));
        useJsx && useJsSource && sourceFileCandidates.add(resolvedSourceFile.replace(/\.m?jsx?$/, '.jsx'));
        useJsSource && sourceFileCandidates.add(resolvedSourceFile.replace(/\.m?jsx?$/, '.js'));
        if (parentKey) {
          let resolvedSourceFileWithoutCondition = resolvedSourceFile.replace('.' + parentKey, '');
          useTsSource && sourceFileCandidates.add(resolvedSourceFileWithoutCondition.replace(/\.m?jsx?$/, '.mts'));
          useJsSource && sourceFileCandidates.add(resolvedSourceFileWithoutCondition.replace(/\.m?jsx?$/, '.mjs'));
          useJsx && useTsSource && sourceFileCandidates.add(resolvedSourceFileWithoutCondition.replace(/\.m?jsx?$/, '.tsx'));
          useTsSource && sourceFileCandidates.add(resolvedSourceFileWithoutCondition.replace(/\.m?jsx?$/, '.ts'));
          useJsx && useJsSource && sourceFileCandidates.add(resolvedSourceFileWithoutCondition.replace(/\.m?jsx?$/, '.jsx'));
          useJsSource && sourceFileCandidates.add(resolvedSourceFileWithoutCondition.replace(/\.m?jsx?$/, '.js'));
        }
        useJsSource && sourceFileCandidates.add(resolvedSourceFile);
        break;
      }
      case 'css': {
        sourceFileCandidates.add(resolvedSourceFile);
        break;
      }
      case 'dts': {
        if (!useTsSource) break;
        if (preferredModule === 'commonjs') {
          sourceFileCandidates.add(resolvedSourceFile.replace(/\.d\.c?ts$/, '.cts'));
        }
        if (preferredModule === 'esmodule') {
          sourceFileCandidates.add(resolvedSourceFile.replace(/\.d\.m?ts$/, '.mts'));
        }
        useJsx && sourceFileCandidates.add(resolvedSourceFile.replace(/\.d\.(m|c)?ts$/, '.tsx'));
        sourceFileCandidates.add(resolvedSourceFile.replace(/\.d\.(m|c)?ts$/, '.ts'));
        break;
      }
      case 'file': {
        if (path.relative(cwd, path.dirname(resolvedOutputFile))) {
          sourceFileCandidates.add(resolvedSourceFile);
        } else {
          sourceFileCandidates.add(resolvedOutputFile);
        }
        break;
      }
    }

    const sourceFile = [...sourceFileCandidates];
    if (useJsx) {
      sourceFile.sort((a, b) => {
        if (a.endsWith('x') && b.endsWith('x')) {
          return 0;
        } else if (a.endsWith('x')) {
          return -1;
        } else {
          return 1;
        }
      });
    }

    entryMap.set(entryPath, {
      key,
      entryPath,
      mode,
      minify,
      sourcemap,
      platform,
      module,
      sourceFile,
      outputFile: resolvedOutputFile,
      customConditions,
    });
  }

  function addMainEntry({
    key,
    entryPath,
  }: {
    key: string;
    entryPath: string;
  }) {
    const ext = path.extname(entryPath);
    switch (ext) {
      case '.cjs': {
        addEntry({
          key,
          sourcemap,
          platform: defaultPlatform,
          mode: defaultMode,
          module: 'commonjs',
          preferredModule: 'commonjs',
          entryPath,
          customConditions: [],
        });
        break;
      }
      case '.mjs': {
        addEntry({
          key,
          sourcemap,
          platform: defaultPlatform,
          mode: defaultMode,
          module: 'esmodule',
          preferredModule: 'esmodule',
          entryPath,
          customConditions: [],
        });
        break;
      }
      case '.node': {
        addEntry({
          key,
          sourcemap,
          platform: 'node',
          mode: defaultMode,
          module: 'file',
          entryPath,
          customConditions: [],
        });
        break;
      }
      case '.json': {
        addEntry({
          key,
          sourcemap,
          platform: defaultPlatform,
          mode: defaultMode,
          module: 'file',
          entryPath,
          customConditions: [],
        });
        break;
      }
      case '.jsx': {
        if (!preserveJsx) {
          reporter.warn(Message.NO_NEED_JSX(entryPath));
        }
      }
      default: {
        addEntry({
          key,
          sourcemap,
          platform: defaultPlatform,
          mode: defaultMode,
          module: defaultModule,
          entryPath,
          customConditions: [],
        });
        break;
      }
    }
  }

  function addModuleEntry({
    key,
    entryPath,
  }: {
    key: string;
    entryPath: string;
  }) {
    if (/\.m?jsx?$/.test(entryPath)) {
      addEntry({
        key,
        sourcemap,
        platform: defaultPlatform,
        mode: defaultMode,
        module: 'esmodule',
        preferredModule: 'esmodule',
        entryPath,
        customConditions: [],
      });
    } else {
      throw new NanobundleEntryError(Message.INVALID_MODULE_EXTENSION());
    }
  }

  function addTypesEntry({
    key,
    entryPath,
  }: {
    key: string;
    entryPath: string;
  }) {
    if (/\.d\.(m|c)?ts$/.test(entryPath)) {
      addEntry({
        key,
        sourcemap,
        platform: defaultPlatform,
        mode: defaultMode,
        module: 'dts',
        preferredModule: defaultPreferredModule,
        entryPath,
        customConditions: [],
      });
    } else {
      throw new NanobundleEntryError(Message.INVALID_TYPES_EXTENSION());
    }
  }

  function addBinEntry({
    key,
    entryPath,
  }: {
    key: string;
    entryPath: string;
  }) {
    const ext = path.extname(entryPath);
    switch (ext) {
      case '.js': {
        addEntry({
          key,
          sourcemap: false,
          platform: 'node',
          mode: defaultMode,
          module: defaultModule,
          preferredModule: defaultPreferredModule,
          entryPath,
          customConditions: [],
        });
        break;
      }
      case '.cjs': {
        addEntry({
          key,
          sourcemap: false,
          platform: 'node',
          mode: defaultMode,
          module: 'commonjs',
          preferredModule: defaultPreferredModule,
          entryPath,
          customConditions: [],
        });
        break;
      }
      case '.mjs': {
        addEntry({
          key,
          sourcemap: false,
          platform: 'node',
          mode: defaultMode,
          module: 'esmodule',
          preferredModule: defaultPreferredModule,
          entryPath,
          customConditions: [],
        });
        break;
      }
      default: {
        throw new NanobundleEntryError(Message.INVALID_BIN_EXTENSION());
      }
    }
  }

  function addConditionalEntry({
    key,
    parentKey,
    platform,
    mode,
    module,
    preferredModule,
    entryPath,
    customConditions,
  }: {
    key: string,
    parentKey: string,
    platform: Entry['platform'],
    mode: Entry['mode'],
    module: Entry['module'],
    preferredModule?: 'commonjs' | 'esmodule',
    entryPath: ConditionalExports,
    customConditions: string[],
  }) {
    if (typeof entryPath === 'string') {
      if (parentKey === 'types') {
        addEntry({
          key,
          parentKey,
          sourcemap,
          platform,
          mode,
          module: 'dts',
          preferredModule,
          entryPath,
          customConditions,
        });
        return;
      }

      const ext = path.extname(entryPath);
      switch (ext) {
        case '.cjs': {
          addEntry({
            key,
            parentKey,
            sourcemap,
            platform,
            mode,
            module: 'commonjs',
            preferredModule: 'commonjs',
            entryPath,
            customConditions,
          });
          break;
        }
        case '.mjs': {
          addEntry({
            key,
            parentKey,
            sourcemap,
            platform,
            mode,
            module: 'esmodule',
            preferredModule: 'esmodule',
            entryPath,
            customConditions,
          });
          break;
        }
        case '.node': {
          addEntry({
            key,
            parentKey,
            sourcemap,
            platform: 'node',
            mode,
            module: 'file',
            preferredModule,
            entryPath,
            customConditions,
          });
          break;
        }
        case '.json': {
          addEntry({
            key,
            parentKey,
            sourcemap,
            platform,
            mode,
            module: 'file',
            preferredModule,
            entryPath,
            customConditions,
          });
          break;
        }
        case '.css': {
          addEntry({
            key,
            parentKey,
            sourcemap,
            platform,
            mode,
            module: 'css',
            preferredModule,
            entryPath,
            customConditions,
          });
          break;
        }
        case '.jsx': {
          if (!preserveJsx) {
            reporter.warn(Message.NO_NEED_JSX(entryPath));
          }
        }
        default: {
          addEntry({
            key,
            parentKey,
            sourcemap,
            platform,
            mode,
            module,
            preferredModule,
            entryPath,
            customConditions,
          });
          break;
        }
      }
    } else if (typeof entryPath === 'object') {
      if (parentKey === 'types') {
        throw new NanobundleEntryError(Message.INVALID_DTS_FORMAT());
      }

      let entries = Object.entries(entryPath);

      if (typeof entryPath.types !== 'undefined') {
        const typesEntryIndex = entries.findIndex(entry => entry[0] === 'types');
        if (typesEntryIndex !== 0) {
          throw new NanobundleEntryError(Message.INVALID_DTS_ORDER());
        }
      } else {
        const firstLeaf = entries.find(([entryKey, entry]) => {
          return typeof entry === 'string' && !entryKey.startsWith('.');
        });
        const isLeaf = firstLeaf !== undefined;

        // has leaf default entry
        if (useTsSource && isLeaf) {
          if (typeof entryPath.default === 'string') {
            const dtsExport: [string, ConditionalExports] = [
              'types$implicit',
              inferDtsEntry(entryPath.default),
            ];
            entries = [dtsExport, ...entries];
          } else if (typeof entryPath.require === 'string' && typeof entryPath.import === 'string') {
            throw new NanobundleEntryError(
              Message.UNDETEMINED_DTS_SOURCE(key, entryPath.require, entryPath.import),
            );
          } else if (typeof entryPath.require === 'string') {
            const dtsExport: [string, ConditionalExports] = [
              'types$implicit',
              inferDtsEntry(entryPath.require),
            ];
            entries = [dtsExport, ...entries];
          } else if (typeof entryPath.import === 'string') {
            const dtsExport: [string, ConditionalExports] = [
              'types$implicit',
              inferDtsEntry(entryPath.import),
            ];
            entries = [dtsExport, ...entries];
          } else if (preferredModule) {
            const dtsExport: [string, ConditionalExports] = [
              'types$implicit',
              inferDtsEntry(firstLeaf[1] as string),
            ];
            entries = [dtsExport, ...entries];
          } else {
            reporter.warn(Message.TYPES_MAY_NOT_BE_RESOLVED(key));
          }
        }
      }

      for (const [currentKey, output] of entries) {
        // See https://nodejs.org/api/packages.html#packages_community_conditions_definitions
        switch (currentKey) {
          case 'import': {
            addConditionalEntry({
              key: `${key}.${currentKey}`,
              parentKey: currentKey,
              platform,
              mode,
              module: 'esmodule',
              preferredModule: 'esmodule',
              entryPath: output,
              customConditions,
            });
            break;
          }
          case 'require': {
            addConditionalEntry({
              key: `${key}.${currentKey}`,
              parentKey: currentKey,
              platform,
              mode,
              module: 'commonjs',
              preferredModule: 'commonjs',
              entryPath: output,
              customConditions,
            });
            break;
          }
          case 'types': {
            addConditionalEntry({
              key: `${key}.${currentKey}`,
              parentKey: currentKey,
              platform,
              mode,
              module: 'dts',
              preferredModule: undefined,
              entryPath: output,
              customConditions,
            });
            break;
          }
          case 'types$implicit': {
            addConditionalEntry({
              key: `${key}.types`,
              parentKey: currentKey,
              platform,
              mode,
              module: 'dts',
              preferredModule,
              entryPath: output,
              customConditions,
            });
            break;
          }
          case 'node': {
            addConditionalEntry({
              key: `${key}.${currentKey}`,
              parentKey: currentKey,
              platform: 'node',
              mode,
              module,
              preferredModule,
              entryPath: output,
              customConditions,
            });
            break;
          }
          case 'deno': {
            addConditionalEntry({
              key: `${key}.${currentKey}`,
              parentKey: currentKey,
              platform: 'deno',
              mode,
              module,
              preferredModule,
              entryPath: output,
              customConditions,
            });
            break;
          }
          case 'browser': {
            addConditionalEntry({
              key: `${key}.${currentKey}`,
              parentKey: currentKey,
              platform: 'browser',
              mode,
              module,
              preferredModule,
              entryPath: output,
              customConditions,
            });
            break;
          }
          case 'development': {
            addConditionalEntry({
              key: `${key}.${currentKey}`,
              parentKey: currentKey,
              platform,
              mode: 'development',
              module,
              preferredModule,
              entryPath: output,
              customConditions,
            });
            break;
          }
          case 'production': {
            addConditionalEntry({
              key: `${key}.${currentKey}`,
              parentKey: currentKey,
              platform,
              mode: 'production',
              module,
              preferredModule,
              entryPath: output,
              customConditions,
            });
            break;
          }
          case 'default': {
            addConditionalEntry({
              key: `${key}.${currentKey}`,
              parentKey: currentKey,
              platform,
              mode,
              module,
              preferredModule,
              entryPath: output,
              customConditions,
            });
            break;
          }
          case '.': {
            addConditionalEntry({
              key: `${key}[\"${currentKey}\"]`,
              parentKey: currentKey,
              platform,
              mode,
              module,
              preferredModule,
              entryPath: output,
              customConditions,
            });
            break;
          }
          default: {
            if (currentKey.startsWith('./')) {
              addConditionalEntry({
                key: `${key}[\"${currentKey}\"]`,
                parentKey: currentKey,
                platform,
                mode,
                module,
                preferredModule,
                entryPath: output,
                customConditions,
              });
            } else {
              reporter.warn(Message.CUSTOM_CONDITION(currentKey));
              addConditionalEntry({
                key: `${key}.${currentKey}`,
                parentKey: currentKey,
                platform,
                mode,
                module,
                preferredModule,
                entryPath: output,
                customConditions: [...new Set([...customConditions, currentKey])],
              });
            }
            break;
          }
        }
      }
    }
  }

  if (manifest.exports) {
    addConditionalEntry({
      key: 'exports',
      parentKey: 'exports',
      platform: defaultPlatform,
      mode: defaultMode,
      module: defaultModule,
      preferredModule: defaultPreferredModule,
      entryPath: manifest.exports,
      customConditions: [],
    });
  } else if (manifest.main || manifest.module) {
    reporter.warn(Message.RECOMMEND_EXPORTS());
  }

  if (typeof manifest.main === 'string') {
    addMainEntry({
      key: 'main',
      entryPath: manifest.main,
    });
  }

  if (typeof manifest.module === 'string') {
    addModuleEntry({
      key: 'module',
      entryPath: manifest.module,
    });
    reporter.warn(Message.MODULE_NOT_RECOMMENDED());
  }

  if (typeof manifest.types === 'string') {
    addTypesEntry({
      key: 'types',
      entryPath: manifest.types,
    });
  }

  if (typeof manifest.bin === 'string') {
    addBinEntry({
      key: 'bin',
      entryPath: manifest.bin,
    });
  }

  if (typeof manifest.bin === 'object') {
    for (const [commandName, entryPath] of Object.entries(manifest.bin)) {
      addBinEntry({
        key: `bin["${commandName}"]`,
        entryPath,
      });
    }
  }

  const entries = [...entryMap.values()];
  return entries;
};

function inferDtsEntry(entryPath: string): string {
  return entryPath.replace(/(\.min)?\.(m|c)?jsx?$/, '.d.$2ts');
}

export class NanobundleEntryError extends NanobundleError {
}

export const Message = {
  INVALID_MAIN_EXTENSION: () => dedent`
    Only ${formatUtils.path('.js')}, ${formatUtils.path('.cjs')}, ${formatUtils.path('.mjs')}, ${formatUtils.path('.json')}, or ${formatUtils.path('.node')} allowed for ${formatUtils.key('main')} entry.

  `,

  INVALID_MODULE_EXTENSION: () => dedent`
    Only ${formatUtils.path('.js')} or ${formatUtils.path('.mjs')} allowed for ${formatUtils.key('module')} entry.

  `,

  INVALID_TYPES_EXTENSION: () => dedent`
    Only ${formatUtils.path('.d.ts')} or ${formatUtils.path('.d.cts')} or ${formatUtils.path('.d.mts')} allowed for ${formatUtils.key('types')} entry.

  `,

  INVALID_BIN_EXTENSION: () => dedent`
    Only JavaScript files are allowed for ${formatUtils.path('bin')} entry.

  `,

  INVALID_PATH_KEY: (path: string) => dedent`
    Invalid entry path ${formatUtils.path(path)}, entry path should starts with ${formatUtils.literal('./')}.

  `,

  INVALID_DTS_FORMAT: () => dedent`
    ${formatUtils.key('types')} entry must be .d.ts file and cannot be nested!

  `,

  INVALID_DTS_ORDER: () => dedent`
    ${formatUtils.key('types')} entry must occur first in conditional exports for correct type resolution.

  `,

  UNDETEMINED_DTS_SOURCE: (key: string, requirePath: string, importPath: string) => dedent`
    ${formatUtils.key('types')} entry doesn't set properly for ${formatUtils.key(key)}:

        "require": "${requirePath}",
        "import": "${importPath}"

    Solution 1. Explicitly set ${formatUtils.key('types')} entry
      
      For example like this

      + "types": "${requirePath.replace(/\.(m|c)?js$/, '.d.ts')}",
        "require": "${requirePath}",
        "import": "${importPath}"

      Or like this

        "require": {
      +   "types": "${requirePath.replace(/\.(m|c)?js$/, '.d.$1ts')}",
          "default": "${requirePath}"
        },
        "import": {
      +   "types": "${importPath.replace(/\.(m|c)?js$/, '.d.$1ts')}",
          "default": "${importPath}"
        }

    Solution 2. Add ${formatUtils.key('default')} entry

        "require": "${requirePath}",
        "import": "${importPath}",
      + "default": "/path/to/entry.js"

  `,

  SUBPATH_PATTERN: (path: string) => dedent`
    Subpath pattern (${formatUtils.path(path)}) is not supported yet.

  `,

  CONFLICT_ENTRY: (a: EntryTarget, b: EntryTarget, hint: string) => formatUtils.format(
    dedent`
      Conflict found for ${formatUtils.path(a.entryPath)}

          %s
          %s

        vs

          %s ${kleur.bold('(conflited)')}
          %s

    `,
    formatUtils.key(a.key),
    formatUtils.object({ module: a.module, platform: a.platform }),
    formatUtils.key(b.key),
    formatUtils.object({ module: b.module, platform: b.platform }),
  ) + hint ? `Hint: ${hint}\n\n` : '',

  PRECEDENSE_ENTRY: (a: EntryTarget, b: EntryTarget) => formatUtils.format(
    dedent`
      Entry ${formatUtils.key(b.key)} will be ignored since

          %s
          %s

        precedense over

          %s ${kleur.bold('(ignored)')}
          %s

    `,
    formatUtils.key(a.key),
    formatUtils.object({ module: a.module, platform: a.platform }),
    formatUtils.key(b.key),
    formatUtils.object({ module: b.module, platform: b.platform }),
  ),

  RECOMMEND_EXPORTS: () => dedent`
    Using ${formatUtils.key('exports')} field is highly recommended.

      See ${formatUtils.hyperlink('https://nodejs.org/api/packages.html')} for more detail.

  `,

  MODULE_NOT_RECOMMENDED: () => dedent`
    ${formatUtils.key('module')} field is not standard and may works in only legacy bundlers. Consider using ${formatUtils.key('exports')} instead.
      See ${formatUtils.hyperlink('https://nodejs.org/api/packages.html')} for more detail.

  `,

  TYPES_MAY_NOT_BE_RESOLVED: (key: string) => dedent`
    ${formatUtils.key(key)} entry might not be resolved correctly in ${formatUtils.key('moduleResolution')}: ${formatUtils.literal('Node16')}.

    Consider to specify ${formatUtils.key('types')} entry for it.

  `,

  NO_NEED_JSX: (path: string) => dedent`
    ${formatUtils.path(path)} doesn't have to be \`.jsx\` unless you are using ${formatUtils.key('preserve')} mode.
  `,

  CUSTOM_CONDITION: (condition: string) => dedent`
    Custom condition ${formatUtils.key(condition)} may has no effects.
  `,

} as const;
