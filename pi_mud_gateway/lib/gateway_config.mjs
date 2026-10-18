import fs from 'node:fs/promises';

const CONFIG_SECTIONS = ['mud', 'auth', 'agent', 'runtime', 'decision'];

export async function loadGatewayConfig(configPath, defaults, { readFile = fs.readFile } = {}) {
  try {
    const raw = await readFile(configPath, 'utf-8');
    const user = JSON.parse(raw);
    const config = {};
    for (const section of CONFIG_SECTIONS) {
      config[section] = {
        ...defaults[section],
        ...(user?.[section] && typeof user[section] === 'object' ? user[section] : {}),
      };
    }
    return config;
  } catch {
    return defaults;
  }
}
