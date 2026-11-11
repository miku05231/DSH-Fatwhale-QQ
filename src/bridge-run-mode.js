// Where the message core runs.
// standalone (default): the companion page supervises src/index.js as its own process.
// embedded: the companion starts that same core inside the DSH host process.

export const BRIDGE_RUN_MODES = Object.freeze(['standalone', 'embedded']);

export function normalizeBridgeRunMode(value) {
  const text = String(value ?? '').trim().toLowerCase();
  return BRIDGE_RUN_MODES.includes(text) ? text : '';
}

/**
 * Plugin config wins over config.json. Missing or unknown values stay standalone
 * so an existing deployment keeps the supervised child process.
 */
export function resolveBridgeRunMode(pluginConfig, bridgeConfig) {
  const fromPlugin = normalizeBridgeRunMode(pluginConfig?.runMode);
  if (fromPlugin) return fromPlugin;
  const fromFile = normalizeBridgeRunMode(bridgeConfig?.bridge?.runMode);
  if (fromFile) return fromFile;
  return 'standalone';
}
