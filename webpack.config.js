const path = require('path');
const fs = require('fs');
const webpack = require('webpack');
const CopyPlugin = require('copy-webpack-plugin');

function loadEnvFile(filePath) {
  if (!fs.existsSync(filePath)) return {};

  const file = fs.readFileSync(filePath, 'utf8');
  const entries = {};

  for (const rawLine of file.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;

    const separatorIndex = line.indexOf('=');
    if (separatorIndex === -1) continue;

    const key = line.slice(0, separatorIndex).trim();
    let value = line.slice(separatorIndex + 1).trim();

    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith('\'') && value.endsWith('\''))
    ) {
      value = value.slice(1, -1);
    }

    if (!(key in process.env)) {
      entries[key] = value;
    }
  }

  return entries;
}

const envDefaults = {
  ...loadEnvFile(path.resolve(__dirname, '.env')),
  ...loadEnvFile(path.resolve(__dirname, '.env.local')),
};

module.exports = (env, argv) => ({
  // 'eval' (webpack's default for dev) is blocked by Chrome extension CSP.
  // 'cheap-module-source-map' writes source maps as separate files — CSP-safe.
  devtool: argv.mode === 'production' ? false : 'cheap-module-source-map',
  entry: {
    background: './src/background.ts',
    popup: './src/popup/popup.ts',
    options: './src/options/options.ts',
  },
  output: {
    path: path.resolve(__dirname, 'dist'),
    filename: '[name].js',
    clean: true,
  },
  module: {
    rules: [
      {
        test: /\.ts$/,
        use: 'ts-loader',
        exclude: /node_modules/,
      },
    ],
  },
  resolve: {
    extensions: ['.ts', '.js'],
  },
  plugins: [
    new webpack.EnvironmentPlugin({
      POSTHOG_KEY: '',
      POSTHOG_HOST: 'https://eu.i.posthog.com',
      FOCUSLINK_DEV_BUILD: argv.mode === 'production' ? 'false' : 'true',
      FOCUSLINK_SYNC_MODE: argv.mode === 'production' ? 'on' : 'off',
      FOCUSLINK_WORKER_URL: argv.mode === 'production' ? 'https://focus.zeyt.io' : '',
      ...envDefaults,
    }),
    new webpack.DefinePlugin({
      'process.env.FOCUSLINK_BUILD_ID': webpack.DefinePlugin.runtimeValue(
        () => JSON.stringify(String(Date.now())),
        true,
      ),
    }),
    new CopyPlugin({
      patterns: [
        { from: 'manifest.json', to: 'manifest.json' },
        { from: 'rules.json', to: 'rules.json' },
        { from: 'public', to: '.' },
        { from: 'src/popup/popup.html', to: 'popup.html' },
        { from: 'src/options/options.html', to: 'options.html' },
      ],
    }),
  ],
  // No code splitting — each entry is a self-contained MV3 script
  optimization: {
    splitChunks: false,
  },
});
