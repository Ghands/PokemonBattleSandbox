'use strict';
/**
 * Standalone config consumed by:
 *   npx electron-builder-ohos --ohos --config electron-builder.ohos.js
 *
 * Do not merge this into package.json's `build` node — the OHOS fork rejects
 * Windows-only keys. See tools/ohos-config.cjs for the actual configuration.
 */
module.exports = require('./tools/ohos-config.cjs').buildOhosConfig(process.env, __dirname);
