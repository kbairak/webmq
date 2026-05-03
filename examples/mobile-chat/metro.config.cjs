const { getDefaultConfig } = require('expo/metro-config');
const path = require('path');

const config = getDefaultConfig(__dirname);

// Add the monorepo packages to watchFolders
const projectRoot = __dirname;
const workspaceRoot = path.resolve(projectRoot, '../..');

config.watchFolders = [workspaceRoot];

// Map webmq packages to their built distributions
config.resolver.extraNodeModules = {
  'webmq-frontend': path.resolve(workspaceRoot, 'packages/frontend'),
  'webmq-backend': path.resolve(workspaceRoot, 'packages/backend'),
};

module.exports = config;
