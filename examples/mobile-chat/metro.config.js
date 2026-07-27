import { getDefaultConfig } from 'expo/metro-config.js';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = path.dirname(fileURLToPath(import.meta.url));
const workspaceRoot = path.resolve(projectRoot, '../..');

const config = getDefaultConfig(projectRoot);
config.watchFolders = [workspaceRoot];
config.resolver.nodeModulesPaths = [
  path.resolve(projectRoot, 'node_modules'),
  path.resolve(workspaceRoot, 'node_modules'),
];

config.resolver.resolveRequest = (context, moduleName, platform) => {
  if (moduleName === 'webmq-frontend') {
    return {
      type: 'sourceFile',
      filePath: path.resolve(workspaceRoot, 'packages/frontend/src/index.ts'),
    };
  }
  return context.resolveRequest(context, moduleName, platform);
};

export default config;
