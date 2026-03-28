const path = require('path');
const webpack = require('webpack');
const CopyPlugin = require('copy-webpack-plugin');

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
